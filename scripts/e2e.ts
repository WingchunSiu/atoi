import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { ModalClient } from "modal";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { createServer } from "../src/api/server.js";
import { ModalAgents } from "../src/modal/provider.js";
import type { Agent } from "../src/model.js";
import { MongoStore } from "../src/store/mongo.js";
import { createActivities } from "../src/temporal/activities.js";
import { reconcile } from "../src/temporal/relay.js";

// Real Pi, Modal and model inference. Local DB requires an explicit opt-in and
// never counts as an Atlas verification. No Git branches are pushed by this check.
const localDatabase = process.env.E2E_LOCAL_DB === "1";
const personalFixture = process.env.E2E_PERSONAL === "1";
if (!localDatabase && !process.env.MONGODB_URI)
  throw new Error(
    "Set MONGODB_URI in .env for Atlas, or E2E_LOCAL_DB=1 for an explicitly local database check.",
  );
const modelApiKey = process.env.ATOI_MODEL_API_KEY ?? process.env.OPENAI_API_KEY;
if (!modelApiKey && !process.env.MODAL_MODEL_SECRET)
  throw new Error("Configure ATOI_MODEL_API_KEY or MODAL_MODEL_SECRET for real model inference.");
const agentSecret = randomBytes(32).toString("hex");
const operatorToken = randomBytes(32).toString("hex");
const marker = `violet-raven-${randomUUID()}`;
const taskQueue = `atoi-e2e-${randomUUID()}`;
function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : "E2E failure";
  for (const secret of [process.env.MONGODB_URI, modelApiKey, agentSecret, operatorToken])
    if (secret) message = message.split(secret).join("[REDACTED]");
  return message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, "[REDACTED DATABASE URI]");
}
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  database: localDatabase ? "local replica set" : "configured MongoDB",
  realModal: true,
  realPi: true,
  realModel: true,
  temporal: "real local service",
  git: personalFixture
    ? "not used; personal planning fixture"
    : "read-only public fixture; no new pushed implementation",
  fixture: personalFixture ? "personal" : "reviewed-public-commit",
};
let database: MongoMemoryReplSet | undefined;
let mongo: MongoClient | undefined;
let modalClient: ModalClient | undefined;
let provider: ModalAgents | undefined;
let store: MongoStore | undefined;
let api: ReturnType<typeof createServer> | undefined;
let temporal: TestWorkflowEnvironment | undefined;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;
let relayTimer: NodeJS.Timeout | undefined;
let tunnel: ChildProcess | undefined;
let agents: Agent[] = [];
let runId: string | undefined;
let relayBusy = false;
let relayFailure: Error | undefined;
async function waitFor(predicate: () => Promise<boolean>, label: string, timeout = 300000) {
  const until = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
    if (relayFailure) throw new Error(`Relay failed: ${relayFailure.name}`);
    if (store && runId) {
      if ((await store.getRun(runId)).status === "failed")
        throw new Error(`Run failed while waiting for ${label}`);
      const failed = await store.agents.find({ runId, status: "needs_inspection" }).next();
      if (failed)
        throw new Error(
          `Agent ${failed.role} needs inspection; inspect persisted invocation results.`,
        );
    }
    await delay(500);
  }
}
async function publicBackendReady(backendUrl: string): Promise<boolean> {
  // Fresh tunnel names can remain negatively cached by macOS getaddrinfo.
  // Query DNS directly, preserving the original hostname for TLS and HTTP.
  return new Promise((resolve) => {
    const request = httpsGet(
      new URL("/health", backendUrl),
      {
        family: 4,
        lookup: (hostname, _options, callback) => {
          resolve4(hostname).then(
            (addresses) => callback(null, addresses[0]!, 4),
            (error: Error) => callback(error, "", 4),
          );
        },
        timeout: 3000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("timeout", () => request.destroy(new Error("Health request timed out")));
    request.on("error", () => resolve(false));
  });
}
async function startTunnel(localUrl: string): Promise<string> {
  const executable = process.env.CLOUDFLARED_PATH ?? "cloudflared";
  tunnel = spawn(
    executable,
    ["tunnel", "--url", localUrl, "--no-autoupdate", "--protocol", "http2"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Cloudflare tunnel startup timed out")), 45000);
    let buffer = "";
    const consume = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-16000);
      const url = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (url) {
        clearTimeout(timer);
        resolve(url[0]);
      }
    };
    tunnel!.stderr!.on("data", consume);
    tunnel!.stdout!.on("data", consume);
    tunnel!.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    tunnel!.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Cloudflare tunnel exited before readiness"));
    });
  });
}
try {
  if (localDatabase)
    database = await MongoMemoryReplSet.create({
      binary: { version: "8.2.3" },
      replSet: { count: 1 },
    });
  const uri = localDatabase ? database!.getUri() : process.env.MONGODB_URI!;
  report.database = localDatabase
    ? "local replica set"
    : uri.startsWith("mongodb+srv://")
      ? "Atlas SRV cluster"
      : "configured MongoDB";
  mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await mongo.connect();
  store = new MongoStore(mongo, mongo.db(process.env.MONGODB_DATABASE ?? "atoi_e2e"), agentSecret);
  await store.initialize();
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  temporal = await TestWorkflowEnvironment.createLocal();
  api = createServer(store, { operatorToken, agentSecret });
  const localUrl = await api.listen({ host: "127.0.0.1", port: 0 });
  const backendUrl = process.env.E2E_BACKEND_URL ?? (await startTunnel(localUrl));
  await waitFor(() => publicBackendReady(backendUrl), "public backend", 60000);
  console.log("Backend reachable over HTTPS; starting real Modal/Pi workers.");
  modalClient = new ModalClient();
  provider = new ModalAgents(modalClient, {
    appName: process.env.MODAL_APP_NAME ?? "atoi-e2e",
    imageTag: process.env.MODAL_IMAGE_TAG ?? "node:24-bookworm-slim",
    modelSecret: process.env.MODAL_MODEL_SECRET,
    modelApiKey,
  });
  const tracedProvider = {
    create: async (...args: Parameters<ModalAgents["create"]>) => {
      try {
        return await provider!.create(...args);
      } catch (error) {
        report.provisioningError = safeError(error);
        console.error(`Provisioning failed: ${report.provisioningError}`);
        throw error;
      }
    },
    invoke: (...args: Parameters<ModalAgents["invoke"]>) => provider!.invoke(...args),
    confirmedResult: (...args: Parameters<ModalAgents["confirmedResult"]>) =>
      provider!.confirmedResult(...args),
    stop: (...args: Parameters<ModalAgents["stop"]>) => provider!.stop(...args),
    stopNamed: (...args: Parameters<ModalAgents["stopNamed"]>) => provider!.stopNamed(...args),
  };
  const activities = createActivities(store, tracedProvider, {
    BACKEND_PUBLIC_URL: backendUrl,
    AGENT_TOKEN_SECRET: agentSecret,
    PI_PROVIDER: process.env.PI_PROVIDER ?? "openai",
    PI_MODEL: process.env.PI_MODEL ?? "gpt-4.1",
    TURN_TIMEOUT_MS: 120000,
    TURN_MODEL_REQUESTS: 12,
    TURN_TOOL_CALLS: 24,
  });
  worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
    activities,
    maxConcurrentActivityTaskExecutions: 3,
  });
  workerRun = worker.run();
  const start = await api.inject({
    method: "POST",
    url: "/operator/runs",
    headers: { authorization: `Bearer ${operatorToken}` },
    payload: {
      requestId: randomUUID(),
      repositoryUrl: personalFixture ? undefined : "https://github.com/octocat/Hello-World.git",
      objective: personalFixture
        ? "Handle this personal planning objective yourself without spawning peers or using Git: create exactly one task for a three-step daily plan with time estimates, claim it, and finish_task with the useful plan as summary and no reviewer or commit. Then finish_run with that plan as outcome and end your turn. This is a generic planning fixture; no external execution is required."
        : `Run a bounded read-only collaboration check against the existing public repository. Spawn exactly two workers with roles implementer and reviewer through spawn_agent; choose their full instructions dynamically from this objective. Do not implement or push a new commit for this fixture.
Create exactly one task (you or the implementer may create it), with acceptance criteria requiring an actual Python assertion that the repository README contains Hello World, case insensitive, printing README_CHECK_PASSED; use the full existing Git SHA and an independent review.
The implementer must claim the task, inspect README and Git SHA, execute that assertion, and write verification-note.md containing this exact marker: ${marker}. It submits in_review using result:{commit:<full SHA>,summary:<summary>,verification:<actual assertion output>} and reviewerId:<actual peer ID>, then DMs the reviewer and ends its turn. Citing the SHA only in text is insufficient for this fixture. The reviewer must fetch/check the exact submitted SHA, independently execute the Python assertion, then use update_task with status done, expectedVersion and review:{commit:<same SHA>,verification:<actual output>}. Only after that tool succeeds and list_tasks confirms done may it DM APPROVED plus the SHA back to the implementer. Inspect and resolve tool errors before reporting success.
On that reply, the implementer must use the read tool on verification-note.md, confirm the task is done, then write_work_log with the marker and approved SHA and DM FOLLOWUP_CONFIRMED to the actual orchestratorId returned by get_run (recipientId must be that ID). A plain unmentioned team post does not wake the orchestrator. It must end the turn and stay available.
Do not call finish_run until you have both the independent review and that FOLLOWUP_CONFIRMED message. Then request completion with the exact reviewed commit and an outcome explicitly stating this was a read-only public-commit fixture. End the final turn immediately. No polling or shell sleep: use addressed messages or schedule_wakeup.`,
      workerLimit: personalFixture ? 0 : 2,
      lifetimeSeconds: 1200,
      maxInvocationsPerAgent: 12,
    },
  });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json();
  runId = started.run._id;
  agents = started.agents;
  report.runId = runId;
  console.log(
    `Run ${runId} accepted; waiting for independently reviewed task and persisted follow-up.`,
  );
  const relay = async () => {
    if (relayBusy) return;
    relayBusy = true;
    try {
      await reconcile(store!, temporal!.client, taskQueue);
      relayFailure = undefined;
    } catch (error) {
      relayFailure = error as Error;
    } finally {
      relayBusy = false;
    }
  };
  relayTimer = setInterval(() => void relay(), 500);
  await relay();
  if (personalFixture) {
    await waitFor(
      async () => (await store!.getRun(runId!)).status === "completed",
      "personal task and run completion",
      240000,
    );
    const run = await store.getRun(runId!);
    const task = await store.tasks.findOne({ runId });
    assert.equal(task?.status, "done");
    assert.equal(task?.ownerId, run.orchestratorId);
    assert.ok(task?.result?.summary);
    assert.equal(task?.result?.commit, undefined);
    assert.equal(task?.reviewerId, null);
    assert.equal(run.repository, undefined);
    assert.equal(await store.agents.countDocuments({ runId }), 1);
    assert.equal(run.completion?.status, "checkpointed");
    assert.ok(run.completion?.outcome);
    assert.ok(await store.checkpoint(await store.getAgent(run.orchestratorId!)));
    report.status = "passed";
    report.task = task;
    report.agents = await store.agents.find({ runId }, { projection: { tokenHash: 0 } }).toArray();
    report.invocations = await store.invocations.find({ agentId: run.orchestratorId! }).toArray();
    report.checks = [
      "real Pi in a repository-free Modal workspace",
      "owner completes a non-code task without peer review",
      "zero-worker personal objective",
      "completion waits for final native checkpoint",
      "confirmed sandbox cleanup and Atlas persistence",
    ];
    console.log(
      "PASS: real personal planning task, no Git or peers, native checkpoint and cleanup.",
    );
  } else {
    await waitFor(
      async () => (await store!.agents.countDocuments({ runId, kind: "worker" })) === 2,
      "orchestrator-spawned workers",
      240000,
    );
    agents = await store.agents.find({ runId }).toArray();
    assert.equal(agents.length, 3);
    const implementer = agents.find((a) => a.role === "implementer")!;
    const reviewer = agents.find((a) => a.role === "reviewer")!;
    assert.ok(implementer && reviewer, "Fixture roles must be chosen by the orchestrator");
    await waitFor(
      async () => !!(await store!.tasks.findOne({ runId, status: "done" })),
      "independent task review",
      600000,
    );
    const followup = await api.inject({
      method: "POST",
      url: `/operator/runs/${runId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        requestId: "operator_checkpoint_followup",
        recipientId: implementer._id,
        body: `Follow-up after approval: use the read tool on verification-note.md, confirm the task is done, then write_work_log with marker ${marker} and the approved full SHA. Send FOLLOWUP_CONFIRMED as a DM to orchestrator agent ${started.run.orchestratorId} using that exact recipientId, and end this turn. Do not create a new task or commit.`,
      },
    });
    assert.equal(followup.statusCode, 200, followup.body);
    report.operatorFollowup = "explicit persisted operator DM after independent review";
    await waitFor(
      async () => {
        const task = await store!.tasks.findOne({ runId, status: "done" });
        return (
          !!task &&
          ["idle", "stopped"].includes((await store!.getAgent(implementer._id)).status) &&
          (await store!.getAgent(implementer._id)).turns >= 2 &&
          !!(await store!.events.findOne({
            runId,
            actorId: implementer._id,
            kind: "work_log",
            "details.payload.note": { $regex: marker },
          }))
        );
      },
      "real peer review and checkpointed follow-up",
      600000,
    );
    await waitFor(
      async () => (await store!.getRun(runId!)).status === "completed",
      "orchestrator completion and cleanup",
      120000,
    );
    const task = await store.tasks.findOne({ runId, status: "done" });
    assert.equal(task!.ownerId, implementer._id);
    assert.equal(task!.reviewerId, reviewer._id);
    assert.equal(task!.review!.commit, task!.result!.commit);
    assert.ok((await store.checkpoint(await store.getAgent(implementer._id)))!.includes(marker));
    const actualAgents = await store.agents.find({ runId }).toArray();
    for (const agent of actualAgents) {
      assert.ok(await store.checkpoint(agent));
      assert.equal(
        await store.deliveries.countDocuments({
          recipientId: agent._id,
          status: { $ne: "completed" },
        }),
        0,
      );
      const outputs = await store.events
        .find({ runId, actorId: agent._id, kind: "tool_execution_end" })
        .toArray();
      if (agent.kind === "worker")
        assert.ok(
          outputs.some((event) => JSON.stringify(event.details).includes("README_CHECK_PASSED")),
          `${agent.role} must actually execute verification`,
        );
    }
    const turns = await store.invocations
      .find({ agentId: implementer._id, status: "completed" })
      .sort({ generation: 1 })
      .toArray();
    assert.ok(turns.length >= 2);
    let previousEntries: { id?: string; type: string }[] | undefined;
    for (const turn of turns) {
      const checkpoint: { jsonl: string } | null = await store.checkpoints.findOne({
        _id: turn._id,
      });
      assert.ok(checkpoint);
      const entries: { id?: string; type: string }[] = checkpoint.jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries[0]!.type, "session");
      if (previousEntries) {
        assert.equal(
          entries[0]!.id,
          previousEntries[0]!.id,
          "Native Pi session identity must persist",
        );
        const entryIds = new Set(entries.map((entry) => entry.id));
        for (const entry of previousEntries)
          if (entry.id)
            assert.ok(entryIds.has(entry.id), "Prior native session entries must survive");
      }
      previousEntries = entries;
    }
    const followupReads = await store.events
      .find({
        runId,
        actorId: implementer._id,
        kind: "tool_execution_end",
        "details.invocationId": { $in: turns.slice(1).map((t) => t._id) },
        "details.payload.toolName": "read",
        "details.payload.isError": { $ne: true },
      })
      .toArray();
    assert.ok(
      followupReads.some((event) => JSON.stringify(event.details).includes(marker)),
      "Follow-up must actually read the retained private file",
    );
    const channel = await store.channels.findOne({
      runId,
      kind: "dm",
      participants: { $all: [implementer._id, reviewer._id] },
    });
    assert.ok(channel);
    assert.ok(
      await store.messages.findOne({
        runId,
        channelId: channel._id,
        senderId: reviewer._id,
        body: { $regex: "APPROVED" },
      }),
    );
    await waitFor(
      async () => (await store!.getRun(runId!)).status === "completed",
      "orchestrator completion and cleanup",
      120000,
    );
    assert.equal((await store.getRun(runId!)).completion?.status, "checkpointed");
    const spawned = await store.events.countDocuments({
      runId,
      kind: "agent.spawned",
      actorId: started.run.orchestratorId,
    });
    assert.equal(spawned, 2);
    report.orchestratorSpawnedWorkers = spawned;
    report.finalCheckpointAndCompletion = "passed";
    report.status = "passed";
    report.task = task;
    report.agents = actualAgents.map(({ tokenHash: _token, ...agent }) => agent);
    report.invocations = await store.invocations
      .find({ agentId: { $in: agents.map((a) => a._id) } })
      .toArray();
    report.messages = await store.messages.find({ runId }).toArray();
    report.checks = [
      "orchestrator dynamically spawns two real Pi workers in separate Modal guests",
      "completion waits for final orchestrator checkpoint and cleans up the whole team",
      "independent exact-commit review",
      "durable DM delivery and Temporal wakeup",
      "operator-triggered native Pi session checkpoint and private file reuse",
      "delivery acknowledgement only with checkpoint publication",
    ];
    console.log(
      "PASS: real peer collaboration, independent review, Modal workspace reuse and Pi checkpoint follow-up.",
    );
  }
} catch (error) {
  report.status = "failed";
  report.error = safeError(error);
  if (store && runId) {
    report.agents = await store.agents.find({ runId }, { projection: { tokenHash: 0 } }).toArray();
    report.invocations = await store.invocations
      .find({ agentId: { $in: agents.map((a) => a._id) } })
      .toArray();
  }
  process.exitCode = 1;
  console.error(`E2E failed: ${report.error}`);
} finally {
  if (store && runId) {
    agents = await store.agents.find({ runId }).toArray();
    try {
      await store.stopRun(runId);
      if (temporal) {
        await reconcile(store, temporal.client, taskQueue);
        await waitFor(
          async () =>
            ["stopped", "completed", "failed"].includes((await store!.getRun(runId!)).status),
          "sandbox cleanup",
          60000,
        );
      }
      report.cleanup = "passed";
    } catch {
      report.cleanup = "fallback termination";
    }
    // Independent final guard, including partial provisioning before Atlas binding.
    if (provider)
      for (const agent of agents) {
        try {
          const current = await store.getAgent(agent._id);
          if (current.sandboxId) await provider.stop(current.sandboxId);
          await provider.stopNamed(agent._id);
        } catch {
          report.cleanup = "failed; operator inspection required";
          process.exitCode = 1;
        }
      }
    // Confirm durability from a new DB connection after API/runner shutdown below.
  }
  if (relayTimer) clearInterval(relayTimer);
  if (worker) {
    worker.shutdown();
    await workerRun?.catch(() => undefined);
  }
  await api?.close();
  tunnel?.kill("SIGTERM");
  await temporal?.teardown();
  modalClient?.close();
  if (mongo && store && runId) {
    const second = new MongoClient(localDatabase ? database!.getUri() : process.env.MONGODB_URI!, {
      serverSelectionTimeoutMS: 15000,
    });
    try {
      await second.connect();
      const db = second.db(store.db.databaseName);
      const run = await db.collection("runs").findOne({ _id: runId } as never);
      const confirmed = await db.collection("agents").countDocuments({
        runId,
        status: "stopped",
        sandboxId: null,
        cleanupCompletedAt: { $type: "date" },
      });
      report.cleanupConfirmations = confirmed;
      report.reconnectPersistence =
        ["stopped", "completed", "failed"].includes(run?.status ?? "") &&
        confirmed === agents.length
          ? "passed"
          : "failed";
      if (report.reconnectPersistence === "failed") {
        report.status = "failed";
        process.exitCode = 1;
      }
    } catch (error) {
      report.reconnectPersistence = "failed";
      report.reconnectError = safeError(error);
      report.status = "failed";
      process.exitCode = 1;
    } finally {
      await second.close();
    }
  }
  await mongo?.close();
  await database?.stop();
  await mkdir(".atoi", { recursive: true });
  await writeFile(".atoi/e2e-report.json", JSON.stringify(report, null, 2));
  console.log(
    `Cleanup: ${report.cleanup ?? "no cloud resources created"}. Report: .atoi/e2e-report.json`,
  );
}
