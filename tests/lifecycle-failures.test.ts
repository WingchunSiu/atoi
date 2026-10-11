import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sha256 } from "../src/agent/runtime.js";
import { createServer } from "../src/api/server.js";
import { runInput } from "../src/contracts/runtime.js";
import { MongoStore } from "../src/store/mongo.js";
import { createActivities } from "../src/temporal/activities.js";
import { reconcile } from "../src/temporal/relay.js";

let database: MongoMemoryReplSet;
let mongo: MongoClient;
let temporal: TestWorkflowEnvironment;
const workflowsPath = fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url));
const secret = "lifecycle-fixture-agent-secret-at-least-32";
const config = {
  BACKEND_PUBLIC_URL: "https://fixture.invalid",
  AGENT_TOKEN_SECRET: secret,
  PI_PROVIDER: "openai",
  PI_MODEL: "gpt-4.1",
  TURN_TIMEOUT_MS: 10000,
  TURN_MODEL_REQUESTS: 1,
  TURN_TOOL_CALLS: 1,
};
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({
    binary: { version: "8.2.3" },
    replSet: { count: 1 },
  });
  mongo = new MongoClient(database.getUri());
  await mongo.connect();
  temporal = await TestWorkflowEnvironment.createLocal();
}, 120000);
afterAll(async () => {
  await temporal?.teardown();
  await mongo?.close();
  await database?.stop();
});
async function fixture(count = 1) {
  const store = new MongoStore(mongo, mongo.db(`atoi_failure_${randomUUID()}`), secret);
  await store.initialize();
  const team = await store.createRun(
    runInput.parse({
      requestId: randomUUID(),
      objective: "Exercise lifecycle failure boundaries",
      repositoryUrl: "https://github.com/octocat/Hello-World.git",
      agents: Array.from({ length: count }, (_, i) => ({
        role: `worker_${i}`,
        instructions: "Wait",
      })),
    }),
  );
  return { store, ...team };
}
const noInvocation = async (): Promise<never> => {
  throw new Error("Unexpected model execution");
};
const stop = async () => {};

it("keeps a run stopping until every unbound named guest is terminated, then retries failed cleanup", async () => {
  const { store, run, agents } = await fixture(2);
  const first = agents[0]!;
  const second = agents[1]!;
  const live = new Set(agents.map((agent) => agent._id));
  let failSecond = true;
  const activities = createActivities(
    store,
    {
      create: noInvocation,
      invoke: noInvocation,
      confirmedResult: async () => null,
      stop,
      stopNamed: async (agentId) => {
        if (agentId === second._id && failSecond)
          throw ApplicationFailure.nonRetryable("Fixture termination failure");
        live.delete(agentId);
      },
    },
    config,
  );
  await store.stopRun(run._id);
  await activities.stopAgent(first._id);
  expect((await store.getRun(run._id)).status).toBe("stopping");
  expect(live).toEqual(new Set([second._id]));

  const taskQueue = `cleanup-failure-${randomUUID()}`;
  const worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath,
    activities,
  });
  await worker.runUntil(async () => {
    await reconcile(store, temporal.client, taskQueue);
    await expect(
      temporal.client.workflow.getHandle(`cleanup/${second._id}`).result(),
    ).rejects.toThrow();
    expect((await store.getRun(run._id)).status).toBe("stopping");
    expect(live.has(second._id)).toBe(true);
    failSecond = false;
    await reconcile(store, temporal.client, taskQueue);
    await temporal.client.workflow.getHandle(`cleanup/${second._id}`).result();
    expect((await store.getRun(run._id)).status).toBe("stopped");
    expect(live.size).toBe(0);
  });
}, 60000);

it("records exhausted provisioning retries without acknowledging or replaying agent work", async () => {
  const { store, run, agents } = await fixture();
  const agent = agents[0]!;
  let attempts = 0;
  const activities = createActivities(
    store,
    {
      create: async () => {
        attempts++;
        throw new Error("Fixture provisioning unavailable");
      },
      invoke: noInvocation,
      confirmedResult: async () => null,
      stop,
      stopNamed: stop,
    },
    config,
  );
  const taskQueue = `provisioning-failure-${randomUUID()}`;
  const worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath,
    activities,
  });
  await worker.runUntil(async () => {
    await reconcile(store, temporal.client, taskQueue);
    await temporal.client.workflow.getHandle(`agent/${agent._id}`).result();
    expect(attempts).toBe(3);
    expect((await store.getAgent(agent._id)).status).toBe("needs_inspection");
    expect(
      await store.invocations.findOne({ agentId: agent._id, status: "uncertain" }),
    ).not.toBeNull();
    expect(
      await store.deliveries.countDocuments({ recipientId: agent._id, status: "processing" }),
    ).toBe(1);
    expect(await store.checkpoints.countDocuments({ agentId: agent._id })).toBe(0);
    await reconcile(store, temporal.client, taskQueue);
    expect(attempts).toBe(3);
    expect((await store.getRun(run._id)).status).toBe("active");
  });
}, 60000);

it("reconciles a failed workflow when its failure-report Activity could not persist", async () => {
  const { store, run, agents } = await fixture();
  const agent = agents[0]!;
  let turns = 0;
  const taskQueue = `failure-report-${randomUUID()}`;
  const worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath,
    activities: {
      turn: async (agentId: string) => {
        turns++;
        await store.beginInvocation(agentId, "interrupted-attempt");
        throw ApplicationFailure.nonRetryable("Fixture terminal execution failure");
      },
      failAgent: async () => {
        throw ApplicationFailure.nonRetryable("Fixture database outage");
      },
    },
  });
  await worker.runUntil(async () => {
    await reconcile(store, temporal.client, taskQueue);
    const handle = temporal.client.workflow.getHandle(`agent/${agent._id}`);
    await expect(handle.result()).rejects.toThrow();
    expect((await store.getAgent(agent._id)).status).toBe("running");
    await store.send(run._id, "operator", {
      requestId: "followup-after-failure",
      recipientId: agent._id,
      body: "New work",
      mentions: [],
    });
    await reconcile(store, temporal.client, taskQueue);
    expect((await store.getAgent(agent._id)).status).toBe("needs_inspection");
    expect((await store.invocations.findOne({ _id: "interrupted-attempt" }))?.status).toBe(
      "uncertain",
    );
    expect(
      await store.deliveries.countDocuments({ recipientId: agent._id, status: "processing" }),
    ).toBe(1);
    expect((await handle.describe()).status.name).toBe("FAILED");
    expect(turns).toBe(1);
  });
}, 60000);

it("rejects runtime-enabled admin registration while preserving coordination-only registration", async () => {
  const { store, run } = await fixture();
  const operatorToken = "lifecycle-fixture-operator-token-at-least-32";
  const app = createServer(store, { operatorToken, agentSecret: secret });
  const input = {
    role: "logical",
    kind: "worker",
    token: "caller-supplied-agent-token-at-least-32",
    runtimeEnabled: true,
  };
  // Reserve space for the admin registration probe.
  await store.runs.updateOne({ _id: run._id }, { $set: { workerLimit: 2 } });
  try {
    const response = await app.inject({
      method: "PUT",
      url: `/admin/runs/${run._id}/agents/admin-probe`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: input,
    });
    expect(response.statusCode).toBe(400);
    expect(await store.agents.findOne({ _id: "admin-probe" })).toBeNull();
    const logical = await app.inject({
      method: "PUT",
      url: `/admin/runs/${run._id}/agents/admin-probe`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { ...input, runtimeEnabled: false },
    });
    expect(logical.statusCode).toBe(200);
    expect(logical.json().runtimeEnabled).toBe(false);
    expect(await store.authenticate(input.token, run._id)).toEqual({
      runId: run._id,
      agentId: "admin-probe",
    });
  } finally {
    await app.close();
  }
});

it("does not confirm cleanup while provisioning can still create a late guest", async () => {
  const { store, run, agents } = await fixture();
  const agent = agents[0]!;
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  let finishCreating!: () => void;
  const creating = new Promise<void>((resolve) => {
    finishCreating = resolve;
  });
  const live = new Set<string>();
  const activities = createActivities(
    store,
    {
      create: async () => {
        announceStarted();
        await creating;
        live.add(agent._id);
        return agent._id;
      },
      invoke: noInvocation,
      confirmedResult: async () => null,
      stop: async (sandboxId) => {
        live.delete(sandboxId);
      },
      stopNamed: async (agentId) => {
        live.delete(agentId);
      },
    },
    config,
  );
  const taskQueue = `late-provisioning-${randomUUID()}`;
  const worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath,
    activities,
  });
  await worker.runUntil(async () => {
    try {
      await reconcile(store, temporal.client, taskQueue);
      await started;
      await store.stopRun(run._id);
      await expect(activities.stopAgent(agent._id)).rejects.toThrow("provisioning");
      expect((await store.getRun(run._id)).status).toBe("stopping");
      finishCreating();
      await reconcile(store, temporal.client, taskQueue);
      await temporal.client.workflow.getHandle(`cleanup/${agent._id}`).result();
      expect((await store.getRun(run._id)).status).toBe("stopped");
      expect(live.size).toBe(0);
    } finally {
      finishCreating();
    }
  });
}, 60000);

it("preserves a committed checkpoint when the Activity completion acknowledgement is lost", async () => {
  const { store, run, agents } = await fixture();
  const agent = agents[0]!;
  const activities = createActivities(
    store,
    {
      create: noInvocation,
      invoke: noInvocation,
      confirmedResult: async () => null,
      stop,
      stopNamed: stop,
    },
    config,
  );
  let turns = 0;
  let followedUp!: () => void;
  const followup = new Promise<void>((resolve) => {
    followedUp = resolve;
  });
  const taskQueue = `committed-failure-${randomUUID()}`;
  const worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath,
    activities: {
      ...activities,
      turn: async (agentId: string) => {
        if (++turns > 1) {
          followedUp();
          return { work: false };
        }
        const context = Context.current();
        const id = createHash("sha256")
          .update(`${context.info.workflowExecution!.runId}:${context.info.activityId}`)
          .digest("hex");
        const invocation = (await store.beginInvocation(agentId, id))!;
        const checkpoint =
          '{"type":"session","version":3,"id":"committed","cwd":"/workspace/repo","timestamp":"2026-10-11T00:00:00Z"}\n';
        await store.complete(agentId, {
          invocationId: id,
          generation: invocation.generation,
          outcome: "completed",
          text: "Confirmed",
          checkpoint,
          checkpointSha256: sha256(checkpoint),
          usage: { input: 1, output: 1, cost: 0, toolCalls: 0, modelRequests: 1, elapsedMs: 1 },
        });
        throw ApplicationFailure.nonRetryable("Fixture lost Activity completion acknowledgement");
      },
    },
  });
  await worker.runUntil(async () => {
    await reconcile(store, temporal.client, taskQueue);
    await followup;
    expect((await store.getAgent(agent._id)).status).toBe("idle");
    expect(
      await store.invocations.countDocuments({ agentId: agent._id, status: "uncertain" }),
    ).toBe(0);
    expect(await store.checkpoints.countDocuments({ agentId: agent._id })).toBe(1);
    expect(
      await store.deliveries.countDocuments({ recipientId: agent._id, status: "completed" }),
    ).toBe(1);
    await store.stopRun(run._id);
    await reconcile(store, temporal.client, taskQueue);
    await temporal.client.workflow.getHandle(`cleanup/${agent._id}`).result();
  });
}, 60000);

it("finalizes an empty logical run without inventing a cleanup acknowledgement", async () => {
  const { store } = await fixture();
  const run = await store.putRun("empty-run", {
    objective: "Empty fixture",
    repository: "https://github.com/octocat/Hello-World.git",
    workerLimit: 1,
  });
  await store.stopRun(run._id);
  expect((await store.getRun(run._id)).status).toBe("stopped");
});

it("does not clear another overlapping provisioning attempt when one retry settles", async () => {
  const { store, run, agents } = await fixture();
  const agent = agents[0]!;
  const invocation = (await store.beginInvocation(agent._id))!;
  const first = await store.beginProvisioning(agent._id, invocation._id, invocation.generation);
  const second = await store.beginProvisioning(agent._id, invocation._id, invocation.generation);
  await store.endProvisioning(invocation._id, first);
  await store.stopRun(run._id);
  const activities = createActivities(
    store,
    {
      create: noInvocation,
      invoke: noInvocation,
      confirmedResult: async () => null,
      stop,
      stopNamed: stop,
    },
    config,
  );
  await expect(activities.stopAgent(agent._id)).rejects.toThrow("provisioning");
  await store.endProvisioning(invocation._id, second);
  await activities.stopAgent(agent._id);
  expect((await store.getRun(run._id)).status).toBe("stopped");
});
