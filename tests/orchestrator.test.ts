import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentToken } from "../src/api/auth.js";
import { createServer } from "../src/api/server.js";
import { runInput } from "../src/contracts/runtime.js";
import type { Actor } from "../src/model.js";
import { MongoStore } from "../src/store/mongo.js";
import { createActivities } from "../src/temporal/activities.js";
import { fixtureResult } from "./runtime-fixture.js";

let database: MongoMemoryReplSet;
let client: MongoClient;
let store: MongoStore;
const secret = "orchestrator-fixture-secret-at-least-32";
const operatorToken = "orchestrator-operator-token-at-least-32";
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({
    binary: { version: "8.2.3" },
    replSet: { count: 1 },
  });
  client = new MongoClient(database.getUri());
  await client.connect();
  store = new MongoStore(client, client.db("orchestrator_test"), secret);
  await store.initialize();
});
afterAll(async () => {
  await client?.close();
  await database?.stop();
});
async function start(workerLimit = 2) {
  const input = runInput.parse({
    requestId: randomUUID(),
    objective: "Complete a reviewed task",
    repositoryUrl: "https://github.com/octocat/Hello-World.git",
    workerLimit,
  });
  const {
    run,
    agents: [orchestrator],
  } = await store.createRun(input);
  const invocation = (await store.beginInvocation(orchestrator!._id))!;
  const actor: Actor = {
    runId: run._id,
    agentId: orchestrator!._id,
    invocationId: invocation._id,
    generation: invocation.generation,
  };
  return { input, run, orchestrator: orchestrator!, invocation, actor };
}
async function workers(actor: Actor) {
  const owner = await store.spawnAgent(actor, {
    requestId: "owner",
    role: "investigator",
    instructions: "Implement the assigned task",
  });
  const reviewer = await store.spawnAgent(actor, {
    requestId: "reviewer",
    role: "verifier",
    instructions: "Independently verify",
  });
  const invoke = async (agentId: string) => {
    const inv = (await store.beginInvocation(agentId))!;
    return { runId: actor.runId, agentId, invocationId: inv._id, generation: inv.generation };
  };
  return {
    owner,
    reviewer,
    ownerActor: await invoke(owner._id),
    reviewerActor: await invoke(reviewer._id),
  };
}
async function reviewedTask(actor: Actor) {
  const team = await workers(actor);
  const task = await store.createTask(team.ownerActor, {
    requestId: "task",
    title: "Bounded implementation",
    description: "A test fixture",
    acceptanceCriteria: ["Verify the exact commit"],
    dependencies: [],
  });
  const claimed = await store.claimTask(team.ownerActor, task._id);
  const commit = "a".repeat(40);
  const submitted = await store.updateTask(team.ownerActor, task._id, {
    expectedVersion: claimed.version,
    status: "in_review",
    reviewerId: team.reviewer._id,
    result: { commit, summary: "Fixture result", verification: "Fixture check passed" },
  });
  await store.updateTask(team.reviewerActor, task._id, {
    expectedVersion: submitted.version,
    status: "done",
    review: { commit, verification: "Independent fixture check passed" },
  });
  return { ...team, task, commit };
}
function lifecycle() {
  const stopped = new Set<string>();
  const activities = createActivities(
    store,
    {
      create: async () => {
        throw new Error("No guest creation in this boundary test");
      },
      invoke: async () => {
        throw new Error("No model invocation in this boundary test");
      },
      confirmedResult: async () => null,
      stop: async (id) => {
        stopped.add(id);
      },
      stopNamed: async (id) => {
        stopped.add(id);
      },
    },
    {
      BACKEND_PUBLIC_URL: "https://fixture.invalid",
      AGENT_TOKEN_SECRET: secret,
      PI_PROVIDER: "openai",
      PI_MODEL: "gpt-4.1",
      TURN_TIMEOUT_MS: 10000,
      TURN_MODEL_REQUESTS: 4,
      TURN_TOOL_CALLS: 8,
    },
  );
  return { activities, stopped };
}

it("starts only one orchestrator and rejects the old seeded-agent input", async () => {
  expect(
    runInput.safeParse({
      requestId: "old",
      objective: "Old",
      repositoryUrl: "https://example.com/repo.git",
      agents: [{ role: "worker", instructions: "Old" }],
    }).success,
  ).toBe(false);
  const { input, run, orchestrator } = await start();
  const again = await store.createRun(input);
  expect(again.agents).toHaveLength(1);
  expect(again.agents[0]!._id).toBe(orchestrator._id);
  expect(run.workerCount).toBe(0);
  expect(run.orchestratorId).toBe(orchestrator._id);
  expect(orchestrator.kind).toBe("orchestrator");
  expect(orchestrator).not.toHaveProperty("tokenHash");
  expect(await store.outbox.countDocuments({ runId: run._id, kind: "run_start" })).toBe(1);
});

it("deduplicates spawn and atomically enforces capacity under concurrent requests", async () => {
  const { actor, run } = await start(3);
  const input = {
    requestId: "duplicate",
    role: "researcher",
    instructions: "Investigate a bounded question",
  };
  const duplicates = await Promise.all(
    Array.from({ length: 6 }, () => store.spawnAgent(actor, input)),
  );
  expect(new Set(duplicates.map((a) => a._id)).size).toBe(1);
  await expect(store.spawnAgent(actor, { ...input, instructions: "Different" })).rejects.toThrow(
    "different input",
  );
  const admissions = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      store.spawnAgent(actor, { ...input, requestId: `new_${i}` }),
    ),
  );
  expect(admissions.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  expect((await store.getRun(run._id)).workerCount).toBe(3);
  expect(
    await store.agents.countDocuments({ runId: run._id, kind: "worker", status: "pending" }),
  ).toBe(3);
  expect(await store.outbox.countDocuments({ runId: run._id, kind: "agent_start" })).toBe(4);
  expect(await store.channels.findOne({ runId: run._id, kind: "team" })).toMatchObject({
    participants: expect.arrayContaining(duplicates.map((a) => a._id)),
  });
});

it("enforces orchestrator capabilities on the backend and supports worker replies to the operator", async () => {
  const { actor, run } = await start();
  const { ownerActor } = await workers(actor);
  const app = createServer(store, { operatorToken, agentSecret: secret });
  const headers = {
    authorization: `Bearer ${agentToken(secret, ownerActor.agentId)}`,
    "x-invocation-id": ownerActor.invocationId!,
    "x-agent-generation": String(ownerActor.generation),
  };
  try {
    for (const [path, payload] of [
      ["agents", { requestId: "forbidden", role: "worker", instructions: "Extra" }],
      ["finish", { requestId: "forbidden", finalCommit: "a".repeat(40), outcome: "Done" }],
    ] as const) {
      expect(
        (await app.inject({ method: "POST", url: `/runs/${run._id}/${path}`, headers, payload }))
          .statusCode,
      ).toBe(403);
    }
    const dm = await store.dm(ownerActor, "operator");
    const message = await store.sendMessage(ownerActor, dm._id, {
      requestId: "operator-reply",
      body: "Here is my finding",
      mentions: [],
    });
    expect(message.recipients).toEqual([]);
    expect(await store.deliveries.countDocuments({ recipientId: "operator" })).toBe(0);
    expect(await store.readChannel(ownerActor, dm._id)).toHaveLength(1);
  } finally {
    await app.close();
  }
});

it("rejects premature completion and records task handoffs for the orchestrator", async () => {
  const { actor, run } = await start();
  const pending = await store.createTask(actor, {
    requestId: "pending",
    title: "Pending work",
    description: "Must finish before the run",
    acceptanceCriteria: ["Return a summary"],
    dependencies: [],
  });
  await expect(
    store.requestFinish(actor, {
      requestId: "early",
      finalCommit: "a".repeat(40),
      outcome: "Done",
    }),
  ).rejects.toThrow("All recorded tasks");
  const claimed = await store.claimTask(actor, pending._id);
  await store.updateTask(actor, pending._id, {
    expectedVersion: claimed.version,
    status: "done",
    result: { summary: "A useful answer without Git or peer review" },
  });
  const { commit } = await reviewedTask(actor);
  await expect(
    store.requestFinish(actor, {
      requestId: "wrong",
      finalCommit: "b".repeat(40),
      outcome: "Done",
    }),
  ).rejects.toThrow("Final commit");
  expect(
    await store.messages.countDocuments({
      runId: run._id,
      senderId: "harness",
      recipients: actor.agentId,
    }),
  ).toBe(2);
  expect((await store.getRun(run._id)).status).toBe("active");
  expect(commit).toHaveLength(40);
});

it("waits for the final native checkpoint, freezes new work and cleans up all three agents", async () => {
  const { actor, run, invocation } = await start();
  const { commit, ownerActor } = await reviewedTask(actor);
  const input = { requestId: "finish", finalCommit: commit, outcome: "Reviewed fixture" };
  await store.requestFinish(actor, input);
  await store.requestFinish(actor, input);
  await expect(
    store.spawnAgent(actor, { requestId: "late", role: "late", instructions: "Late work" }),
  ).rejects.toThrow();
  await expect(
    store.sendMessage(ownerActor, "missing", { requestId: "late", body: "Late", mentions: [] }),
  ).rejects.toThrow();
  const { activities, stopped } = lifecycle();
  expect(await activities.superviseRun(run._id)).toMatchObject({ finished: false });
  expect(stopped.size).toBe(0);
  await store.recordEvent(actor, {
    requestId: "final-text",
    type: "message_end",
    payload: { text: "Ending final turn" },
  });
  await store.complete(actor.agentId, fixtureResult(invocation._id, invocation.generation));
  expect(await activities.superviseRun(run._id)).toMatchObject({ finished: true });
  expect((await store.getRun(run._id)).status).toBe("stopping");
  const agents = await store.agents.find({ runId: run._id }).toArray();
  for (const agent of agents) await activities.stopAgent(agent._id);
  expect(stopped).toEqual(new Set(agents.map((a) => a._id)));
  expect(await store.getRun(run._id)).toMatchObject({
    status: "completed",
    completion: { status: "checkpointed", finalCommit: commit },
  });
  expect(await store.checkpoints.countDocuments({ agentId: actor.agentId })).toBe(1);
});

it("fails completion and still cleans up when the final invocation is ambiguous or times out", async () => {
  for (const mode of ["ambiguous", "timeout"] as const) {
    const { actor, run, invocation } = await start();
    const { commit } = await reviewedTask(actor);
    await store.requestFinish(actor, {
      requestId: "finish",
      finalCommit: commit,
      outcome: "Reviewed fixture",
    });
    if (mode === "ambiguous")
      await store.uncertain(actor.agentId, invocation._id, "Lost final turn");
    else
      await store.runs.updateOne(
        { _id: run._id },
        { $set: { "completion.deadline": new Date(0) } },
      );
    const { activities } = lifecycle();
    expect(await activities.superviseRun(run._id)).toMatchObject({ finished: true });
    for (const agent of await store.agents.find({ runId: run._id }).toArray())
      await activities.stopAgent(agent._id);
    expect(await store.getRun(run._id)).toMatchObject({
      status: "failed",
      failure: expect.any(String),
    });
  }
});

it("keeps timers durable, deduplicated and cancelled with the run", async () => {
  const { actor, run, invocation } = await start();
  const input = { requestId: "timer", delaySeconds: 1, note: "Check peer progress" };
  const first = await store.scheduleWakeup(actor, input);
  expect((await store.scheduleWakeup(actor, input))._id).toBe(first._id);
  await store.complete(actor.agentId, fixtureResult(invocation._id, invocation.generation));
  await store.wakeups.updateOne({ _id: first._id }, { $set: { wakeAt: new Date(0) } });
  const next = (await store.beginInvocation(actor.agentId))!;
  expect(next.prompt).toContain("Check peer progress");
  expect(await store.wakeups.findOne({ _id: first._id })).toMatchObject({ status: "fired" });
  await store.scheduleWakeup(
    { ...actor, invocationId: next._id, generation: next.generation },
    { ...input, requestId: "cancelled" },
  );
  await store.stopRun(run._id);
  expect(await store.wakeups.countDocuments({ runId: run._id, status: "pending" })).toBe(0);
});

it("supports a personal objective without Git, workers, tasks or mandatory peer review", async () => {
  const {
    run,
    agents: [orchestrator],
  } = await store.createRun(
    runInput.parse({
      requestId: randomUUID(),
      objective: "Answer a personal planning question",
      workerLimit: 0,
    }),
  );
  const invocation = (await store.beginInvocation(orchestrator!._id))!;
  const actor = {
    runId: run._id,
    agentId: orchestrator!._id,
    invocationId: invocation._id,
    generation: invocation.generation,
  };
  expect(run.repository).toBeUndefined();
  await expect(
    store.spawnAgent(actor, { requestId: "over-budget", role: "peer", instructions: "Unneeded" }),
  ).rejects.toThrow("Worker limit");
  await store.requestFinish(actor, {
    requestId: "answer",
    outcome: "Here is a useful plan",
    evidence: ["Requester constraints from this conversation"],
  });
  await store.complete(actor.agentId, fixtureResult(invocation._id, invocation.generation));
  const { activities } = lifecycle();
  await activities.superviseRun(run._id);
  await activities.stopAgent(actor.agentId);
  expect(await store.getRun(run._id)).toMatchObject({
    status: "completed",
    completion: { outcome: "Here is a useful plan" },
  });
});

it("lets a worker finish a non-code task, stay available and receive a later DM", async () => {
  const { actor, run } = await start();
  const worker = await store.spawnAgent(actor, {
    requestId: "planner",
    role: "planner",
    instructions: "Make a plan",
  });
  const invocation = (await store.beginInvocation(worker._id))!;
  const workerActor = {
    runId: run._id,
    agentId: worker._id,
    invocationId: invocation._id,
    generation: invocation.generation,
  };
  const task = await store.createTask(workerActor, {
    requestId: "plan",
    title: "Plan the week",
    description: "A personal planning task",
    acceptanceCriteria: ["Produce a usable plan"],
    dependencies: [],
  });
  const claimed = await store.claimTask(workerActor, task._id);
  await store.updateTask(workerActor, task._id, {
    expectedVersion: claimed.version,
    status: "done",
    result: { summary: "Prioritized weekly plan", evidence: ["User's stated priorities"] },
  });
  await store.complete(worker._id, fixtureResult(invocation._id, invocation.generation));
  expect((await store.getAgent(worker._id)).status).toBe("idle");
  expect((await store.getRun(run._id)).status).toBe("active");
  await store.send(run._id, "operator", {
    requestId: "followup",
    recipientId: worker._id,
    body: "Adjust the plan for Friday",
    mentions: [],
  });
  expect((await store.beginInvocation(worker._id))!.prompt).toContain("Adjust the plan for Friday");
});

it("approves a non-code review without a commit and explains an incorrect result payload", async () => {
  const { actor } = await start();
  const { ownerActor, reviewerActor, reviewer } = await workers(actor);
  const task = await store.createTask(ownerActor, {
    requestId: "checklist",
    title: "Prepare a checklist",
    description: "No repository artifact",
    acceptanceCriteria: ["Three usable steps"],
    dependencies: [],
  });
  const claimed = await store.claimTask(ownerActor, task._id);
  const submitted = await store.updateTask(ownerActor, task._id, {
    expectedVersion: claimed.version,
    status: "in_review",
    reviewerId: reviewer._id,
    result: { summary: "Prepare, demonstrate, follow up" },
  });
  await expect(
    store.updateTask(reviewerActor, task._id, {
      expectedVersion: submitted.version,
      status: "done",
      result: { summary: "Approved", verification: "All three steps checked" },
    }),
  ).rejects.toThrow("review.verification, not result");
  const approved = await store.updateTask(reviewerActor, task._id, {
    expectedVersion: submitted.version,
    status: "done",
    review: { verification: "All three steps independently checked" },
  });
  expect(approved.status).toBe("done");
  expect(approved.review?.commit).toBeUndefined();
});
