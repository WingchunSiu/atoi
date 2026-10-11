import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { ModalClient } from "modal";
import { type WorkerRequest, workerResult } from "../src/contracts/runtime.js";
import { ModalAgents } from "../src/modal/provider.js";
import type { Agent, Run } from "../src/store/mongo.js";

const client = new ModalClient();
const provider = new ModalAgents(client, {
  appName: process.env.MODAL_APP_NAME ?? "atoi-runtime-smoke",
  imageTag: process.env.MODAL_IMAGE_TAG ?? "node:24-bookworm-slim",
});
const agent: Agent = {
  _id: randomUUID(),
  runId: randomUUID(),
  role: "smoke",
  kind: "worker",
  runtimeEnabled: true,
  tokenHash: "fixture",
  createdAt: new Date(),
  instructions: "Smoke fixture",
  status: "pending",
  generation: 0,
  turns: 0,
  toolEpoch: 0,
  sandboxId: null,
  cleanupCompletedAt: null,
  checkpointId: null,
  invocationId: null,
};
const run: Run = {
  _id: agent.runId,
  workerLimit: 1,
  workerCount: 1,
  orchestratorId: null,
  createdAt: new Date(),
  objective: "Verify Modal filesystem and native Pi persistence",
  repository: "https://github.com/octocat/Hello-World.git",
  status: "active",
  deadline: new Date(Date.now() + 10 * 60 * 1000),
  maxInvocationsPerAgent: 3,
};
let sandboxId: string | undefined;
async function invoke(stage: "first" | "second", checkpoint: string | null) {
  const sandbox = await client.sandboxes.fromId(sandboxId!);
  try {
    const request: WorkerRequest = {
      agentId: agent._id,
      runId: agent.runId,
      invocationId: `smoke-${stage}`,
      generation: stage === "first" ? 1 : 2,
      role: agent.role,
      instructions: agent.instructions,
      prompt:
        stage === "first"
          ? "Create memory and consult the reviewer."
          : "Resume your memory and inspect your workspace.",
      backendUrl: "https://example.invalid",
      token: "fixture-token-32-characters-or-more",
      provider: "openai",
      model: "gpt-4.1",
      checkpoint,
      budget: { timeoutMs: 30000, modelRequests: 8, toolCalls: 8 },
    };
    const process = await sandbox.exec(["node", "/opt/atoi/modal-fixture.mjs"], {
      timeoutMs: 60000,
    });
    await process.stdin.writeText(JSON.stringify({ stage, request }));
    await process.stdin.close();
    const [code, stdout, stderr] = await Promise.all([
      process.wait(),
      process.stdout.readText(),
      process.stderr.readText(),
    ]);
    assert.equal(code, 0, `Modal Pi fixture exited ${code}: ${stderr.slice(-2000)}`);
    const output = JSON.parse(stdout) as {
      result: unknown;
      restoredContext: boolean;
      nativeTools: string[];
    };
    const result = workerResult.parse(output.result);
    assert.equal(result.outcome, "completed", result.error ?? "Pi fixture failed");
    return { ...output, result };
  } finally {
    sandbox.detach();
  }
}

try {
  console.log("Creating one temporary Modal sandbox (10-minute maximum; cleanup runs in finally).");
  sandboxId = await provider.create(agent, run);
  const sandbox = await client.sandboxes.fromId(sandboxId);
  await sandbox.filesystem.copyFromLocal(
    "dist/guest/modal-fixture.mjs",
    "/opt/atoi/modal-fixture.mjs",
  );
  sandbox.detach();
  const first = await invoke("first", null);
  assert.ok(first.nativeTools.includes("bash") && first.nativeTools.includes("send_message"));
  // Invoke a new guest process and restore the checkpoint from the harness side.
  const second = await invoke("second", first.result.checkpoint);
  assert.equal(second.restoredContext, true);
  const reattached = await client.sandboxes.fromId(sandboxId);
  assert.equal(
    await reattached.filesystem.readText("/workspace/repo/atoi-memory.txt"),
    "The recovery marker is violet-raven.",
  );
  reattached.detach();
  await mkdir(".atoi", { recursive: true });
  await writeFile(
    ".atoi/modal-smoke.json",
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        sandboxId,
        modalVersion: "0.11.0",
        piVersion: "1.1.0",
        realModal: true,
        realPiSdk: true,
        model: "scripted fixture",
        backend: "scripted fixture",
        atlas: "not used",
        reattachment: "passed",
        filesystemRetention: "passed",
        nativeSessionRecovery: "passed",
        turns: [first.result.usage, second.result.usage],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real Modal reattachment, retained files, native Pi session restore, normal coding tools and added coordination tool. Model/backend were scripted fixtures.",
  );
} finally {
  if (sandboxId) await provider.stop(sandboxId);
  await provider.stopNamed(agent._id);
  client.close();
  console.log("Temporary smoke sandbox cleanup completed.");
}
