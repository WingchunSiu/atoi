import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  database: localDatabase ? "local replica set" : "configured MongoDB",
  realModal: true,
  realPi: true,
  realModel: true,
  temporal: "real local service",
  git: "read-only public fixture; no new pushed implementation",
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
      const failed = await store.agents.find({ runId, status: "needs_inspection" }).next();
      if (failed)
        throw new Error(
          `Agent ${failed.role} needs inspection; inspect persisted invocation results.`,
        );
    }
    await delay(500);
  }
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
  await waitFor(
    async () => {
      try {
        const response = await fetch(new URL("/health", backendUrl), {
          signal: AbortSignal.timeout(3000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    "public backend",
    60000,
  );
  console.log("Backend reachable over HTTPS; starting real Modal/Pi workers.");
  modalClient = new ModalClient();
  provider = new ModalAgents(modalClient, {
    appName: process.env.MODAL_APP_NAME ?? "atoi-e2e",
    imageTag: process.env.MODAL_IMAGE_TAG ?? "node:24-bookworm-slim",
    modelSecret: process.env.MODAL_MODEL_SECRET,
    modelApiKey,
  });
  const activities = createActivities(store, provider, {
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
    maxConcurrentActivityTaskExecutions: 2,
  });
  workerRun = worker.run();
  const start = await api.inject({
    method: "POST",
    url: "/operator/runs",
    headers: { authorization: `Bearer ${operatorToken}` },
    payload: {
      requestId: randomUUID(),
      repositoryUrl: "https://github.com/octocat/Hello-World.git",
      objective:
        "Independently verify that the current public repository README contains the greeting Hello World. Complete exactly one reviewed task and exchange a direct peer reply.",
      lifetimeSeconds: 1200,
      maxInvocationsPerAgent: 6,
      agents: [
        {
          role: "implementer",
          instructions: `You initiate exactly one task. Use list_agents to find the reviewer. Create a task with title and acceptanceCriteria array; claim it and keep its version. Inspect the actual README and current Git SHA using bash. Run a Python assertion that README contains Hello World (case insensitive) and print README_CHECK_PASSED on success. Write verification-note.md in your private workspace containing the exact marker ${marker}. Submit in_review with the exact existing commit, actual verification notes and reviewerId. DM the reviewer with task ID and commit. Then finish this turn immediately; do not poll. When woken by the approval reply, read verification-note.md using read, list_tasks to confirm done, write a work log containing the exact marker and the approved commit, and finish. Do not create another task. No Git push is required: this is a read-only verification task on an existing public commit.`,
        },
        {
          role: "reviewer",
          instructions:
            "Initially wait for an explicit review DM; finish your turn without polling or claiming work. When a review DM arrives, list_tasks to obtain the latest version and exact submitted commit. Independently inspect that exact commit in your own Git clone and run a Python assertion on its README for Hello World (case insensitive), printing README_CHECK_PASSED on success. Use update_task to approve done with expectedVersion and review:{commit,verification}. Only approve if your actual assertion passes. Then DM the implementer with APPROVED and the commit. Finish the turn; do not poll. No Git push is required.",
        },
      ],
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
  const implementer = agents.find((a) => a.role === "implementer")!;
  const reviewer = agents.find((a) => a.role === "reviewer")!;
  await waitFor(
    async () => {
      const task = await store!.tasks.findOne({ runId, status: "done" });
      return (
        !!task &&
        (await store!.getAgent(implementer._id)).status === "idle" &&
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
  const task = await store.tasks.findOne({ runId, status: "done" });
  assert.equal(task!.ownerId, implementer._id);
  assert.equal(task!.reviewerId, reviewer._id);
  assert.equal(task!.review!.commit, task!.result!.commit);
  assert.ok((await store.checkpoint(await store.getAgent(implementer._id)))!.includes(marker));
  const actualAgents = await store.agents.find({ runId }).toArray();
  for (const agent of actualAgents) {
    assert.ok(agent.sandboxId);
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
    assert.ok(
      outputs.some((event) => JSON.stringify(event.details).includes("README_CHECK_PASSED")),
      `${agent.role} must actually execute verification`,
    );
  }
  const guest = await modalClient.sandboxes.fromId(
    (await store.getAgent(implementer._id)).sandboxId!,
  );
  try {
    assert.ok(
      (await guest.filesystem.readText("/workspace/repo/verification-note.md")).includes(marker),
    );
  } finally {
    guest.detach();
  }
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
  report.status = "passed";
  report.task = task;
  report.agents = actualAgents.map(({ tokenHash: _token, ...agent }) => agent);
  report.invocations = await store.invocations
    .find({ agentId: { $in: agents.map((a) => a._id) } })
    .toArray();
  report.messages = await store.messages.find({ runId }).toArray();
  report.checks = [
    "real model/tool execution in separate Modal guests",
    "independent exact-commit review",
    "durable DM delivery and Temporal wakeup",
    "native Pi session checkpoint and private file reuse",
    "delivery acknowledgement only with checkpoint publication",
  ];
  console.log(
    "PASS: real peer collaboration, independent review, Modal workspace reuse and Pi checkpoint follow-up.",
  );
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : "E2E failure";
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
    try {
      await store.stopRun(runId);
      if (temporal) {
        await reconcile(store, temporal.client, taskQueue);
        await waitFor(
          async () => (await store!.getRun(runId!)).status === "stopped",
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
      report.reconnectPersistence = run?.status === "stopped" ? "passed" : "failed";
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
