import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../src/agent/runtime.js";
import { agentToken } from "../src/api/auth.js";
import { createServer } from "../src/api/server.js";
import { runInput, type WorkerResult } from "../src/contracts/runtime.js";
import { type Agent, MongoStore } from "../src/store/mongo.js";
import { fixtureTeam } from "./runtime-fixture.js";

let server: MongoMemoryReplSet;
let client: MongoClient;
let store: MongoStore;
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({
    binary: { version: "8.0.15" },
    replSet: { count: 1 },
  });
  client = new MongoClient(server.getUri());
  await client.connect();
  store = new MongoStore(client, client.db("atoi_test"), "test-only-agent-secret-at-least-32");
  await store.initialize();
}, 120000);
afterAll(async () => {
  await client?.close();
  await server?.stop();
});

async function team() {
  return fixtureTeam(store, [
    { role: "implementer", instructions: "Implement" },
    { role: "reviewer", instructions: "Review" },
  ]);
}
const result = (invocationId: string, generation: number): WorkerResult => {
  const checkpoint =
    '{"type":"session","version":3,"id":"test","cwd":"/workspace/repo","timestamp":"2026-10-11T00:00:00Z"}\n';
  return {
    invocationId,
    generation,
    outcome: "completed",
    text: "Checkpointed",
    checkpoint,
    checkpointSha256: sha256(checkpoint),
    usage: {
      input: 1,
      output: 1,
      cost: 0,
      toolCalls: 0,
      modelRequests: 1,
      elapsedMs: 10,
    },
  };
};

describe("real MongoDB replica-set persistence", () => {
  it("finalizes once when all agents confirm cleanup concurrently and retry acknowledgements", async () => {
    const { run } = await team();
    const agents = await store.agents.find({ runId: run._id }).toArray();
    await store.stopRun(run._id);
    await Promise.all(agents.map((agent) => store.confirmCleanup(agent._id)));
    expect((await store.getRun(run._id)).status).toBe("stopped");
    expect(await store.agents.countDocuments({ runId: run._id, cleanupCompletedAt: null })).toBe(0);
    await Promise.all(agents.map((agent) => store.confirmCleanup(agent._id)));
    expect(await store.events.countDocuments({ runId: run._id, kind: "run.finished" })).toBe(1);
  });

  it("deduplicates starts and concurrent message delivery transactionally", async () => {
    const input = runInput.parse({
      requestId: randomUUID(),
      objective: "Test",
      repositoryUrl: "https://github.com/octocat/Hello-World.git",
      workerLimit: 1,
    });
    const starts = await Promise.all([store.createRun(input), store.createRun(input)]);
    expect(starts[0].run._id).toBe(starts[1].run._id);
    const recipientId = starts[0].agents[0]!._id;
    const send = {
      requestId: "duplicate",
      recipientId,
      body: "One durable message",
      mentions: [],
    };
    const messages = await Promise.all(
      Array.from({ length: 4 }, () => store.send(starts[0].run._id, "operator", send)),
    );
    expect(new Set(messages.map((message) => message._id)).size).toBe(1);
    expect(await store.deliveries.countDocuments({ messageId: messages[0]!._id })).toBe(1);
    expect(await store.outbox.countDocuments({ recipientId, kind: "mailbox_wakeup" })).toBe(2);
  });

  it("serializes turns, atomically publishes checkpoints and acknowledgements, and rejects stale results", async () => {
    const { agents } = await team();
    const agentId = agents[0]!._id;
    const invocations = await Promise.all([
      store.beginInvocation(agentId),
      store.beginInvocation(agentId),
    ]);
    expect(invocations[0]!._id).toBe(invocations[1]!._id);
    const invocation = invocations[0]!;
    await expect(
      store.complete(agentId, result(invocation._id, invocation.generation + 1)),
    ).rejects.toThrow("Stale");
    expect(await store.checkpoints.countDocuments({ agentId })).toBe(0);
    await store.complete(agentId, result(invocation._id, invocation.generation));
    await store.complete(agentId, result(invocation._id, invocation.generation));
    expect((await store.getAgent(agentId)).status).toBe("idle");
    expect(
      await store.deliveries.countDocuments({ recipientId: agentId, status: "completed" }),
    ).toBe(1);
    expect(await store.checkpoint(await store.getAgent(agentId))).toContain('"type":"session"');
    const retry = await store.beginInvocation(agentId, invocation._id);
    expect(retry?.status).toBe("completed");
    expect((await store.getAgent(agentId)).turns).toBe(1);
  });

  it("keeps ambiguous work unacknowledged and queues independent cleanup on stop", async () => {
    const { run, agents } = await team();
    const invocation = (await store.beginInvocation(agents[0]!._id))!;
    await store.uncertain(agents[0]!._id, invocation._id, "Lost guest response");
    expect(await store.beginInvocation(agents[0]!._id)).toBeNull();
    expect(
      await store.deliveries.countDocuments({
        recipientId: agents[0]!._id,
        status: "processing",
      }),
    ).toBe(1);
    await store.stopRun(run._id);
    expect(await store.outbox.countDocuments({ runId: run._id, kind: "stop" })).toBe(3);
    await expect(
      store.complete(agents[0]!._id, result(invocation._id, invocation.generation)),
    ).rejects.toThrow("Stale");
  });

  it("authenticates agent tools and fences requests after the invocation commits", async () => {
    const { agents } = await team();
    const agent = agents[0]! as Agent;
    const invocation = (await store.beginInvocation(agent._id))!;
    const secret = "test-only-agent-secret-at-least-32";
    const app = createServer(store, {
      operatorToken: "test-only-operator-token-at-least-32",
      agentSecret: secret,
    });
    const url = `/runs/${agent.runId}/agents`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const headers = {
      authorization: `Bearer ${agentToken(secret, agent._id)}`,
      "x-invocation-id": invocation._id,
      "x-agent-generation": String(invocation.generation),
    };
    expect((await app.inject({ url, headers })).statusCode).toBe(200);
    await store.complete(agent._id, result(invocation._id, invocation.generation));
    expect((await app.inject({ url, headers })).statusCode).toBe(409);
    await app.close();
  });
});
