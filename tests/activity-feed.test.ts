import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentToken } from "../src/api/auth.js";
import { createServer } from "../src/api/server.js";
import { type Activity, watchActivity } from "../src/client/activity.js";
import { runInput } from "../src/contracts/runtime.js";
import { MongoStore } from "../src/store/mongo.js";

let database: MongoMemoryReplSet;
let client: MongoClient;
let store: MongoStore;
const operatorToken = "activity-test-operator-token-32-characters";
const agentSecret = "activity-test-agent-secret-32-characters";
const headers = { authorization: `Bearer ${operatorToken}` };
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({
    binary: { version: "8.0.15" },
    replSet: { count: 1 },
  });
  client = new MongoClient(database.getUri());
  await client.connect();
  store = new MongoStore(client, client.db("activity_test"), agentSecret);
  await store.initialize();
});
afterAll(async () => {
  await client?.close();
  await database?.stop();
});
async function team() {
  return store.createRun(
    runInput.parse({
      requestId: randomUUID(),
      objective: "Observe a team",
      repositoryUrl: "https://github.com/octocat/Hello-World.git",
      agents: [
        { role: "implementer", instructions: "Implement" },
        { role: "reviewer", instructions: "Review" },
      ],
    }),
  );
}

it("orders concurrent events transactionally, rejects conflicting retries and replays by cursor", async () => {
  const { run, agents } = await team();
  await Promise.all(agents.map((agent) => store.beginInvocation(agent._id)));
  const current = await Promise.all(agents.map((agent) => store.getAgent(agent._id)));
  const initialEvents = await store.events.countDocuments({ runId: run._id });
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      const agent = current[i % current.length]!;
      return store.mutateInvocation(
        agent._id,
        agent.invocationId!,
        agent.generation,
        (active, session) =>
          store.recordInvocationEvent(
            active,
            active.invocationId!,
            {
              requestId: `event-${i}`,
              type: "tool_execution_start",
              payload: { toolName: "read", index: i },
            },
            session,
          ),
      );
    }),
  );
  const agent = current[0]!;
  const event = {
    requestId: "duplicate",
    type: "message_end",
    payload: { text: "once" },
  };
  const write = (input = event) =>
    store.mutateInvocation(agent._id, agent.invocationId!, agent.generation, (active, session) =>
      store.recordInvocationEvent(active, active.invocationId!, input, session),
    );
  await Promise.all([write(), write()]);
  await expect(write({ ...event, payload: { text: "different" } })).rejects.toThrow(
    "different input",
  );
  const ordered = await store.events.find({ runId: run._id }).sort({ sequence: 1 }).toArray();
  expect(ordered.map((event) => event.sequence)).toEqual(
    Array.from({ length: initialEvents + 13 }, (_, i) => i + 1),
  );
  const app = createServer(store, { operatorToken, agentSecret });
  try {
    const first = (
      await app.inject({
        url: `/operator/runs/${run._id}/events?limit=4`,
        headers,
      })
    ).json();
    expect(first.events).toHaveLength(4);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBe(4);
    const next = (
      await app.inject({
        url: `/operator/runs/${run._id}/events?after=4&agentId=${agent._id}`,
        headers,
      })
    ).json();
    expect(
      next.events.every((event: Activity) => event.agentId === agent._id && event.sequence > 4),
    ).toBe(true);
    expect(next.events.every((event: Record<string, unknown>) => !("requestHash" in event))).toBe(
      true,
    );
    expect(
      (
        await app.inject({
          url: `/operator/runs/${run._id}/events?after=100`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});

it("authenticates history/streams, fences stale events and keeps work logs separate from tasks", async () => {
  const { run, agents } = await team();
  const other = await team();
  const agent = agents[0]!;
  const invocation = (await store.beginInvocation(agent._id))!;
  const app = createServer(store, { operatorToken, agentSecret });
  try {
    for (const suffix of ["events", "events/stream", `agents/${agent._id}`]) {
      expect((await app.inject({ url: `/operator/runs/${run._id}/${suffix}` })).statusCode).toBe(
        401,
      );
    }
    expect(
      (
        await app.inject({
          url: `/operator/runs/${run._id}/events?agentId=${other.agents[0]!._id}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/operator/runs/${run._id}/events?after=-1`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const auth = {
      authorization: `Bearer ${agentToken(agentSecret, agent._id)}`,
      "x-invocation-id": invocation._id,
      "x-agent-generation": String(invocation.generation),
    };
    const log = {
      requestId: "note",
      note: "Found the edge case",
      nextStep: "Run a regression test",
      evidence: ["parser.ts"],
      sessionId: "pi-session",
    };
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/runs/${agent.runId}/logs`,
            headers: auth,
            payload: log,
          })
        ).statusCode,
      ).toBe(200);
    expect(await store.events.countDocuments({ runId: run._id, kind: "work_log" })).toBe(1);
    expect(await store.tasks.countDocuments({ runId: run._id })).toBe(0);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/runs/${agent.runId}/events`,
          headers: auth,
          payload: {
            requestId: "spoof",
            type: "invocation_finished",
            payload: { status: "idle" },
          },
        })
      ).statusCode,
    ).toBe(400);
    await store.stopRun(run._id);
    const stoppedGeneration = (await store.getAgent(agent._id)).generation;
    await store.stopRun(run._id);
    expect((await store.getAgent(agent._id)).generation).toBe(stoppedGeneration);
    expect(
      await store.events.countDocuments({
        runId: run._id,
        actorId: agent._id,
        kind: "agent_stopped",
      }),
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/runs/${agent.runId}/logs`,
          headers: auth,
          payload: { ...log, requestId: "stale" },
        })
      ).statusCode,
    ).toBe(409);
    const history = (
      await app.inject({
        url: `/operator/runs/${run._id}/events?type=work_log`,
        headers,
      })
    ).json();
    expect(history.events[0]).toMatchObject({
      sessionId: "pi-session",
      payload: { source: "agent_reported" },
    });
  } finally {
    await app.close();
  }
});

it("streams persisted history and live events, resumes after reconnect, and closes cleanly", async () => {
  const { run, agents } = await team();
  const invocation = (await store.beginInvocation(agents[0]!._id))!;
  const agent = await store.getAgent(agents[0]!._id);
  const app = createServer(store, { operatorToken, agentSecret });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  async function receive(after: number, expected: number, action?: () => Promise<void>) {
    const abort = new AbortController();
    const events: Activity[] = [];
    const timer = setTimeout(() => abort.abort(new Error("No activity received")), 5000);
    const stream = watchActivity({
      baseUrl,
      token: operatorToken,
      runId: run._id,
      agentId: agent._id,
      after,
      signal: abort.signal,
      onConnection: (state) => {
        if (state === "live" && action) void action();
      },
      onEvent: (event) => {
        events.push(event);
        if (events.length === expected) abort.abort();
      },
    });
    try {
      await stream;
      expect(events).toHaveLength(expected);
      return events;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
  try {
    const expectedHistory = await store.events
      .find({ runId: run._id, actorId: agent._id })
      .sort({ sequence: 1 })
      .toArray();
    const first = await receive(0, expectedHistory.length);
    expect(first.some((event) => event.type === "invocation_started")).toBe(true);
    const after = first.at(-1)!.sequence;
    const second = await receive(after, 1, () =>
      store.mutateInvocation(agent._id, invocation._id, invocation.generation, (active, session) =>
        store.recordInvocationEvent(
          active,
          invocation._id,
          {
            requestId: "live",
            type: "message_end",
            payload: { text: "新的活动" },
          },
          session,
        ),
      ),
    );
    expect(second[0]!.sequence).toBe(after + 1);
    const unauthorized = watchActivity({
      baseUrl,
      token: "wrong",
      runId: run._id,
      signal: AbortSignal.timeout(2000),
      onEvent() {},
    });
    await expect(unauthorized).rejects.toThrow("401");
    const connection = await fetch(`${baseUrl}/operator/runs/${run._id}/events/stream`, {
      headers,
    });
    const reader = connection.body!.getReader();
    await reader.read();
    await app.close();
    while (!(await reader.read()).done) {
      /* drain buffered history before EOF */
    }
    reader.releaseLock();
  } finally {
    await app.close();
  }
});

it("accepts bounded worker output over 64KB and excludes credentials from agent detail", async () => {
  const { run, agents } = await team();
  const agent = agents[0]!;
  const invocation = (await store.beginInvocation(agent._id))!;
  const app = createServer(store, { operatorToken, agentSecret });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const workerHeaders = {
    authorization: `Bearer ${agentToken(agentSecret, agent._id)}`,
    "x-invocation-id": invocation._id,
    "x-agent-generation": String(invocation.generation),
    "content-type": "application/json",
  };
  try {
    const send = (requestId: string, text: string) =>
      fetch(`${baseUrl}/runs/${run._id}/events`, {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify({ requestId, type: "tool_execution_end", payload: { text } }),
      });
    const accepted = await send("large-output", "结果".repeat(19000));
    expect(accepted.status).toBe(200);
    const tooLarge = await send("too-large", "x".repeat(129000));
    expect(tooLarge.status).toBe(400);
    expect(await store.events.countDocuments({ runId: run._id, kind: "tool_execution_end" })).toBe(
      1,
    );
    const detail = (
      await app.inject({
        url: `/operator/runs/${run._id}/agents/${agent._id}`,
        headers,
      })
    ).json();
    expect(detail.agent).not.toHaveProperty("tokenHash");
    expect(detail.invocations[0]).not.toHaveProperty("prompt");
    expect(detail.lastActivity).toMatchObject({ agentId: agent._id, type: "tool_execution_end" });
    const resumed = await fetch(`${baseUrl}/operator/runs/${run._id}/events/stream`, {
      headers: { ...headers, "last-event-id": "999999" },
    });
    expect(resumed.status).toBe(400);
  } finally {
    await app.close();
  }
});
