import { createHash, randomUUID } from "node:crypto";
import type { Client } from "@temporalio/client";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseEvent } from "../dashboard/src/contract/events.js";
import { agentToken } from "../src/api/auth.js";
import { dashboardEvent } from "../src/api/dashboard.js";
import { createServer } from "../src/api/server.js";
import { runInput, type WorkerResult } from "../src/contracts/runtime.js";
import type { Actor } from "../src/model.js";
import { MongoStore } from "../src/store/mongo.js";
import { createActivities } from "../src/temporal/activities.js";
import { reconcile } from "../src/temporal/relay.js";

let replica: MongoMemoryReplSet;
let client: MongoClient;
let store: MongoStore;
const secret = "orchestration-test-agent-secret-at-least-32";
const operatorToken = "orchestration-test-operator-token-at-least-32";
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({
    binary: { version: "8.2.3" },
    replSet: { count: 1 },
  });
  client = await new MongoClient(replica.getUri()).connect();
  store = new MongoStore(client, client.db(`atoi_test_${randomUUID()}`), secret);
  await store.initialize();
});
afterAll(async () => {
  await client?.close();
  await replica?.stop();
});
async function team(limit = 2) {
  const { run, agents } = await store.createRun(
    runInput.parse({
      requestId: randomUUID(),
      objective: "Fix parser and independently review",
      repositoryUrl: "https://github.com/example/fixture.git",
      workerLimit: limit,
    }),
  );
  const agent = agents[0]!;
  const invocation = (await store.beginInvocation(agent._id))!;
  const actor: Actor = {
    agentId: agent._id,
    runId: run._id,
    invocationId: invocation._id,
    generation: invocation.generation,
  };
  return { run, agent, invocation, actor };
}
function result(actor: Actor): WorkerResult {
  const checkpoint =
    '{"type":"session","version":3,"id":"fixture","cwd":"/workspace/repo","timestamp":"2026-10-11T00:00:00Z"}\n';
  return {
    invocationId: actor.invocationId!,
    generation: actor.generation!,
    outcome: "completed",
    text: "done",
    checkpoint,
    checkpointSha256: createHash("sha256").update(checkpoint).digest("hex"),
    usage: { input: 1, output: 1, cost: 0, elapsedMs: 1, toolCalls: 0, modelRequests: 1 },
  };
}
it("deduplicates orchestrator spawns and enforces concurrent capacity including a third worker", async () => {
  const { run, actor } = await team(3);
  const spawn = { requestId: "implementer", role: "implementer", instructions: "Fix parser" };
  const duplicates = await Promise.all([store.spawn(actor, spawn), store.spawn(actor, spawn)]);
  expect(duplicates[0]._id).toBe(duplicates[1]._id);
  const attempts = await Promise.allSettled(
    ["reviewer", "third", "overflow"].map((role) =>
      store.spawn(actor, { requestId: role, role, instructions: role }),
    ),
  );
  expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(2);
  expect((await store.getRun(run._id)).workerCount).toBe(3);
  expect(await store.agents.countDocuments({ runId: run._id })).toBe(4);
  await expect(store.spawn(actor, { ...spawn, role: "different" })).rejects.toThrow(
    "different input",
  );
  const worker = duplicates[0];
  const invocation = (await store.beginInvocation(worker._id))!;
  await expect(
    store.spawn(
      {
        ...actor,
        agentId: worker._id,
        invocationId: invocation._id,
        generation: invocation.generation,
      },
      { requestId: "forbidden", role: "peer", instructions: "test" },
    ),
  ).rejects.toThrow("Only the orchestrator");
});
it("checkpoints reviewed objectives, accepts follow-ups with the same agents, and cleans up only on Stop", async () => {
  const { run, actor } = await team();
  const commit = "a".repeat(40);
  await expect(store.completeObjective(actor, { commit, summary: "done" })).rejects.toThrow(
    "All tasks",
  );
  const implementer = await store.spawn(actor, {
    requestId: "i",
    role: "implementer",
    instructions: "fix",
  });
  const reviewer = await store.spawn(actor, {
    requestId: "r",
    role: "reviewer",
    instructions: "review",
  });
  const ownerTurn = (await store.beginInvocation(implementer._id))!;
  const reviewerTurn = (await store.beginInvocation(reviewer._id))!;
  const owner: Actor = {
    runId: run._id,
    agentId: implementer._id,
    invocationId: ownerTurn._id,
    generation: ownerTurn.generation,
  };
  const review: Actor = {
    runId: run._id,
    agentId: reviewer._id,
    invocationId: reviewerTurn._id,
    generation: reviewerTurn.generation,
  };
  const task = await store.createTask(actor, {
    requestId: "task",
    title: "Parser",
    description: "Fix parser",
    acceptanceCriteria: ["tests pass"],
    dependencies: [],
  });
  await store.claimTask(owner, task._id);
  await store.updateTask(owner, task._id, {
    expectedVersion: 2,
    status: "in_review",
    reviewerId: reviewer._id,
    result: { commit, summary: "Fixed", verification: "Fixture only: node --test" },
  });
  await store.updateTask(review, task._id, {
    expectedVersion: 3,
    status: "done",
    review: { commit, verification: "Independent fixture review" },
  });
  await store.completeObjective(actor, { commit, summary: "Reviewed branch" });
  expect((await store.getRun(run._id)).status).toBe("active");
  expect(await store.outbox.countDocuments({ runId: run._id, kind: "stop" })).toBe(0);
  await store.complete(actor.agentId, result(actor));
  expect((await store.getRun(run._id)).status).toBe("active");
  expect((await store.getRun(run._id)).completion?.confirmed).toBe(true);
  expect(await store.outbox.countDocuments({ runId: run._id, kind: "stop" })).toBe(0);
  const checkpoint = await store.checkpoint(await store.getAgent(actor.agentId));
  const message = await store.send(run._id, "operator", {
    requestId: "follow-up",
    recipientId: actor.agentId,
    body: "Add another feature using the same team",
    mentions: [],
  });
  const next = (await store.beginInvocation(actor.agentId))!;
  expect(next.prompt).toContain("Add another feature");
  expect(await store.checkpoint(await store.getAgent(actor.agentId))).toBe(checkpoint);
  const nextActor = { ...actor, invocationId: next._id, generation: next.generation };
  await store.createTask(nextActor, {
    requestId: "second-task",
    title: "Second feature",
    description: "Follow-up",
    acceptanceCriteria: ["review"],
    dependencies: [],
  });
  expect((await store.getRun(run._id)).completion).toBeUndefined();
  expect(await store.agents.countDocuments({ runId: run._id })).toBe(3);
  await store.complete(actor.agentId, result(nextActor));
  expect((await store.deliveries.findOne({ messageId: message._id }))?.status).toBe("completed");
  await store.stopRun(run._id);
  expect((await store.getRun(run._id)).status).toBe("stopping");
  expect(await store.outbox.countDocuments({ runId: run._id, kind: "stop" })).toBe(3);
  for (const agent of await store.agents.find({ runId: run._id }).toArray())
    await store.confirmCleanup(agent._id);
  expect((await store.getRun(run._id)).status).toBe("stopped");
  const events = (await store.events.find({ runId: run._id }).toArray())
    .map(dashboardEvent)
    .filter(Boolean);
  for (const event of events)
    expect(parseEvent(event), JSON.stringify(event)).toMatchObject({ ok: true });
  expect(events.some((event) => event?.type === "run.state" && event.status === "available")).toBe(
    true,
  );
});
it("replays valid dashboard events, authenticates operators, and permits durable replies to operator DMs", async () => {
  const { run, actor } = await team();
  const app = createServer(store, { agentSecret: secret, operatorToken });
  try {
    const url = `/operator/runs/${run._id}/dashboard-events`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${operatorToken}` };
    const message = await store.send(run._id, "operator", {
      requestId: "hello",
      recipientId: actor.agentId,
      body: "Hello",
      mentions: [],
    });
    const dm = await store.dm(actor, "operator");
    const reply = await store.sendMessage(actor, dm._id, {
      requestId: "reply",
      body: "Hello operator",
      mentions: [],
    });
    expect(await store.deliveries.countDocuments({ messageId: reply._id })).toBe(0);
    const events: Array<Record<string, unknown>> = [];
    let cursor = 0;
    while (true) {
      const response = await app.inject({ url: `${url}?after=${cursor}&limit=2`, headers });
      expect(response.statusCode).toBe(200);
      const page = response.json();
      events.push(...page.events);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(events.length).toBeGreaterThan(3);
    for (const event of events)
      expect(parseEvent(event), JSON.stringify(event)).toMatchObject({ ok: true });
    expect(events.some((e) => e.messageId === message._id && e.clientRequestId === "hello")).toBe(
      true,
    );
    expect(
      events.some((e) => e.messageId === reply._id && (e.to as string[]).includes("user")),
    ).toBe(true);
    expect((await app.inject({ url: `${url}?after=${cursor}`, headers })).json().events).toEqual(
      [],
    );
    expect(
      (
        await app.inject({
          url,
          headers: { authorization: `Bearer ${agentToken(secret, actor.agentId)}` },
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
  }
});
it("replaces only idle checkpointed sandboxes, terminates old execution first and preserves queued messages", async () => {
  const { run, actor } = await team();
  await expect(
    store.requestRecovery(run._id, actor.agentId, { requestId: "r", commit: "a".repeat(40) }),
  ).rejects.toThrow("idle");
  await store.bindSandbox(actor.agentId, "old-sandbox");
  await store.complete(actor.agentId, result(actor));
  const input = { requestId: "replace", commit: "b".repeat(40) };
  await store.requestRecovery(run._id, actor.agentId, input);
  const message = await store.send(run._id, "operator", {
    requestId: "offline",
    recipientId: actor.agentId,
    body: "Follow up after replacement",
    mentions: [],
  });
  expect(await store.beginInvocation(actor.agentId)).toBeNull();
  const calls: string[] = [];
  const activities = createActivities(
    store,
    {
      stop: async (id) => {
        calls.push(`stop:${id}`);
      },
      stopNamed: async () => {},
      create: async (agent) => {
        expect(await store.checkpoint(agent)).toContain('"type":"session"');
        expect(agent.recovery?.commit).toBe(input.commit);
        calls.push("create");
        return "replacement";
      },
      invoke: async () => {
        throw new Error("Unexpected invocation");
      },
      confirmedResult: async () => null,
    },
    {
      BACKEND_PUBLIC_URL: "https://fixture.invalid",
      AGENT_TOKEN_SECRET: secret,
      PI_PROVIDER: "openai",
      PI_MODEL: "fixture",
      TURN_TIMEOUT_MS: 1000,
      TURN_MODEL_REQUESTS: 1,
      TURN_TOOL_CALLS: 1,
    },
  );
  await activities.replaceAgent(actor.agentId, input.requestId);
  await activities.replaceAgent(actor.agentId, input.requestId);
  expect(calls).toEqual(["stop:old-sandbox", "create"]);
  const next = (await store.beginInvocation(actor.agentId))!;
  expect(next.prompt).toContain(message.body);
  expect(next.generation).toBeGreaterThan(actor.generation!);
  expect((await store.getAgent(actor.agentId)).sandboxId).toBe("replacement");
});

it("keeps cleanup unconfirmed while a replacement may still create a sandbox", async () => {
  const { run, actor } = await team();
  await store.complete(actor.agentId, result(actor));
  await store.requestRecovery(run._id, actor.agentId, {
    requestId: "race",
    commit: "c".repeat(40),
  });
  const first = (await store.beginRecoveryProvisioning(actor.agentId, "race"))!;
  const second = (await store.beginRecoveryProvisioning(actor.agentId, "race"))!;
  await store.stopRun(run._id);
  await store.endRecoveryProvisioning(actor.agentId, "race", first.attemptId);
  await expect(store.confirmCleanup(actor.agentId)).rejects.toThrow("still in flight");
  await expect(store.finishRecovery(actor.agentId, "race", "late-sandbox")).rejects.toThrow(
    "stopped",
  );
  await store.endRecoveryProvisioning(actor.agentId, "race", second.attemptId);
  await store.confirmCleanup(actor.agentId);
  expect((await store.getRun(run._id)).status).toBe("stopped");
});

it("records exhausted replacement retries and budget failures as valid dashboard events", async () => {
  const { run, actor } = await team();
  await store.complete(actor.agentId, result(actor));
  await store.requestRecovery(run._id, actor.agentId, {
    requestId: "failed",
    commit: "c".repeat(40),
  });
  await store.failRecovery(actor.agentId, "failed");
  await store.failRecovery(actor.agentId, "failed");
  expect((await store.getAgent(actor.agentId)).recovery?.status).toBe("failed");
  expect(await store.events.countDocuments({ runId: run._id, kind: "failure.recorded" })).toBe(1);
  const app = createServer(store, { agentSecret: secret, operatorToken });
  try {
    const page = (
      await app.inject({
        url: `/operator/runs/${run._id}/dashboard-events`,
        headers: { authorization: `Bearer ${operatorToken}` },
      })
    ).json();
    for (const event of page.events)
      expect(parseEvent(event), JSON.stringify(event)).toMatchObject({ ok: true });
  } finally {
    await app.close();
  }
});

it("scopes acceptance-test scheduling and diagnoses old run records without stranding new work", async () => {
  const { run, actor } = await team();
  const legacyId = `legacy-${randomUUID()}`;
  await store.db.collection("runs").insertOne({ _id: legacyId as never, status: "active" });
  await store.outbox.insertOne({
    _id: legacyId,
    runId: legacyId,
    recipientId: "old-logical-agent",
    kind: "mailbox_wakeup",
    status: "pending",
    createdAt: new Date(),
  });
  const starts: string[] = [];
  const client = {
    workflow: {
      start: async (_name: string, { workflowId }: { workflowId: string }) => {
        starts.push(workflowId);
      },
      signalWithStart: async (_name: string, { workflowId }: { workflowId: string }) => {
        starts.push(workflowId);
      },
      getHandle: () => ({ describe: async () => ({ status: { name: "RUNNING" } }) }),
    },
  } as unknown as Client;
  await reconcile(store, client, "test", run._id);
  expect(starts).toEqual(expect.arrayContaining([`run/${run._id}`, `agent/${actor.agentId}`]));
  expect(starts.every((id) => id.includes(run._id) || id.includes(actor.agentId))).toBe(true);
  expect(await store.outbox.findOne({ _id: legacyId })).toMatchObject({ status: "pending" });
  await reconcile(store, client, "test", legacyId);
  expect(await store.outbox.findOne({ _id: legacyId })).toMatchObject({
    status: "pending",
    error: expect.stringContaining("lifecycle fields"),
  });
  expect(starts.some((id) => id.includes(legacyId))).toBe(false);
});

it("rejects unconfigured repositories before persisting a run and never exposes secret names", async () => {
  const app = createServer(
    store,
    { agentSecret: secret, operatorToken },
    { "example/allowed": "private-secret-name" },
  );
  const headers = { authorization: `Bearer ${operatorToken}` };
  try {
    const denied = await app.inject({
      method: "POST",
      url: "/operator/runs",
      headers,
      payload: {
        requestId: randomUUID(),
        repositoryUrl: "https://github.com/example/other.git",
        objective: "Build app",
      },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.body).toContain("not configured");
    const list = await app.inject({ url: "/operator/repositories", headers });
    expect(list.json()).toEqual({
      restricted: true,
      repositories: [{ name: "example/allowed", url: "https://github.com/example/allowed.git" }],
    });
    expect(list.body).not.toContain("private-secret-name");
    const accepted = await app.inject({
      method: "POST",
      url: "/operator/runs",
      headers,
      payload: {
        requestId: randomUUID(),
        repositoryUrl: "https://github.com/Example/Allowed",
        objective: "Build an app from scratch",
      },
    });
    expect(accepted.statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it("publishes plain final answers to operator DMs atomically and deduplicates result retries", async () => {
  const { run, actor } = await team();
  await store.complete(actor.agentId, result(actor));
  const dm = await store.send(run._id, "operator", {
    requestId: "question",
    recipientId: actor.agentId,
    body: "Explain the result",
    mentions: [],
  });
  const turn = (await store.beginInvocation(actor.agentId))!;
  const replyActor = { ...actor, invocationId: turn._id, generation: turn.generation };
  const answer = { ...result(replyActor), text: "Here is the retained explanation." };
  await store.complete(actor.agentId, answer);
  await store.complete(actor.agentId, answer);
  const replies = await store.messages
    .find({ channelId: dm.channelId, senderId: actor.agentId })
    .toArray();
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ body: answer.text, replyTo: dm._id });
  expect((await store.deliveries.findOne({ messageId: dm._id }))?.status).toBe("completed");
  expect(await store.checkpoint(await store.getAgent(actor.agentId))).toBe(answer.checkpoint);
});
it("does not duplicate an explicit operator reply or broadcast private final answers to peers", async () => {
  const { run, actor } = await team();
  await store.complete(actor.agentId, result(actor));
  const dm = await store.send(run._id, "operator", {
    requestId: "question",
    recipientId: actor.agentId,
    body: "Explain",
    mentions: [],
  });
  const turn = (await store.beginInvocation(actor.agentId))!;
  const replyActor = { ...actor, invocationId: turn._id, generation: turn.generation };
  await store.sendMessage(replyActor, dm.channelId, {
    requestId: "explicit",
    body: "The actual answer",
    mentions: [],
  });
  await store.complete(actor.agentId, { ...result(replyActor), text: "Sent the answer." });
  expect(
    await store.messages.countDocuments({ channelId: dm.channelId, senderId: actor.agentId }),
  ).toBe(1);
  expect(await store.messages.countDocuments({ runId: run._id, body: "Sent the answer." })).toBe(0);
});

it("bounds automatic chat replies without losing the full checkpointed answer", async () => {
  const { run, actor } = await team();
  await store.complete(actor.agentId, result(actor));
  const dm = await store.send(run._id, "operator", {
    requestId: "long-question",
    recipientId: actor.agentId,
    body: "Explain fully",
    mentions: [],
  });
  const turn = (await store.beginInvocation(actor.agentId))!;
  const nextActor = { ...actor, invocationId: turn._id, generation: turn.generation };
  await store.complete(actor.agentId, { ...result(nextActor), text: "x".repeat(40000) });
  const reply = (await store.messages.findOne({
    channelId: dm.channelId,
    senderId: actor.agentId,
  }))!;
  expect(reply.body.length).toBeLessThanOrEqual(32000);
  expect(reply.body).toContain("Reply truncated");
  expect((await store.invocations.findOne({ _id: turn._id }))?.result?.text.length).toBe(40000);
});
