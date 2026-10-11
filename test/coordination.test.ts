import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { buildApp } from "../src/app.js";
import type { Channel, Message, Task } from "../src/model.js";
import { CoordinationStore } from "../src/store.js";

const admin = "operator-secret-".repeat(4);
const token = (id: string) => `${id}-${"secret".repeat(8)}`;
let replica: MongoMemoryReplSet | undefined;
let client: MongoClient;
let app: FastifyInstance;
let store: CoordinationStore;
const databaseName = `atoi_test_${randomUUID().replaceAll("-", "")}`;
before(
  async () => {
    if (!process.env.TEST_MONGODB_URI) {
      await mkdir(".cache/mongodb", { recursive: true });
      replica = await MongoMemoryReplSet.create({
        binary: { version: "8.2.3", downloadDir: ".cache/mongodb" },
        replSet: { count: 1, storageEngine: "wiredTiger" },
      });
    }
    const uri = process.env.TEST_MONGODB_URI ?? replica?.getUri();
    assert.ok(uri);
    client = await new MongoClient(uri).connect();
    store = new CoordinationStore(client, client.db(databaseName));
    await store.initialize();
    app = buildApp(store, admin);
    await app.ready();
  },
  { timeout: 180000 },
);
after(async () => {
  if (app) await app.close();
  if (client) {
    await client.db(databaseName).dropDatabase();
    await client.close();
  }
  if (replica) await replica.stop();
});
async function call(
  method: "GET" | "PUT" | "POST" | "PATCH",
  url: string,
  credential: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${credential}` },
    ...(payload ? { payload } : {}),
  });
}
async function fixture(workerLimit = 4) {
  const runId = randomUUID();
  const ids = ["owner", "reviewer", "peer"].map((name) => `${name}-${randomUUID()}`);
  const [owner, reviewer, peer] = ids;
  assert.ok(owner && reviewer && peer);
  assert.equal(
    (
      await call("PUT", `/admin/runs/${runId}`, admin, {
        objective: "Fixture objective",
        repository: "fixture://repo",
        workerLimit,
      })
    ).statusCode,
    200,
  );
  for (const id of ids)
    assert.equal(
      (
        await call("PUT", `/admin/runs/${runId}/agents/${id}`, admin, {
          role: id.split("-")[0],
          kind: "worker",
          token: token(id),
        })
      ).statusCode,
      200,
    );
  const channels = (await call("GET", `/runs/${runId}/channels`, token(owner))).json<{
    items: Channel[];
  }>();
  const team = channels.items.find((c) => c.kind === "team");
  assert.ok(team);
  return { runId, owner, reviewer, peer, team, prefix: `/runs/${runId}` };
}
async function newTask(
  prefix: string,
  owner: string,
  dependencies: string[] = [],
  requestId: string = randomUUID(),
) {
  const result = await call("POST", `${prefix}/tasks`, token(owner), {
    requestId,
    title: "Fix parser",
    description: "Handle an empty input",
    acceptanceCriteria: ["Empty input passes"],
    dependencies,
  });
  assert.equal(result.statusCode, 200, result.body);
  return result.json<Task>();
}

test("only one contender owns a task; repeating the winning claim is harmless", async () => {
  const { prefix, owner, reviewer, peer } = await fixture();
  const task = await newTask(prefix, owner);
  const responses = await Promise.all(
    [owner, reviewer, peer].map((id) =>
      call("POST", `${prefix}/tasks/${task._id}/claim`, token(id)),
    ),
  );
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409, 409]);
  const winner = responses.find((r) => r.statusCode === 200)?.json<Task>();
  assert.ok(winner?.ownerId);
  assert.equal(
    (await call("POST", `${prefix}/tasks/${task._id}/claim`, token(winner.ownerId))).json<Task>()
      .version,
    winner.version,
  );
  assert.equal(await store.events.countDocuments({ kind: "task.claimed", entityId: task._id }), 1);
});

test("task dependencies, versions and independent exact-commit review are enforced", async () => {
  const { prefix, owner, reviewer, peer } = await fixture();
  const task = await newTask(prefix, owner);
  const dependent = await newTask(prefix, peer, [task._id]);
  assert.equal(
    (await call("POST", `${prefix}/tasks/${dependent._id}/claim`, token(peer))).statusCode,
    409,
  );
  await call("POST", `${prefix}/tasks/${task._id}/claim`, token(owner));
  const result = {
    commit: "a".repeat(40),
    summary: "Implemented",
    verification: "Fixture test passed",
  };
  const submitted = await call("PATCH", `${prefix}/tasks/${task._id}`, token(owner), {
    expectedVersion: 2,
    status: "in_review",
    reviewerId: reviewer,
    result,
  });
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(
    (
      await call("PATCH", `${prefix}/tasks/${task._id}`, token(owner), {
        expectedVersion: 2,
        status: "blocked",
        reason: "Stale",
      })
    ).statusCode,
    409,
  );
  const approve = {
    expectedVersion: 3,
    status: "done",
    review: { commit: result.commit, verification: "Verified by reviewer" },
  };
  assert.equal(
    (await call("PATCH", `${prefix}/tasks/${task._id}`, token(owner), approve)).statusCode,
    403,
  );
  assert.equal(
    (await call("PATCH", `${prefix}/tasks/${task._id}`, token(peer), approve)).statusCode,
    403,
  );
  assert.equal(
    (
      await call("PATCH", `${prefix}/tasks/${task._id}`, token(reviewer), {
        ...approve,
        review: { ...approve.review, commit: "b".repeat(40) },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("PATCH", `${prefix}/tasks/${task._id}`, token(reviewer), approve)).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", `${prefix}/tasks/${dependent._id}/claim`, token(peer))).statusCode,
    200,
  );
  assert.equal(
    (
      await call("PATCH", `${prefix}/tasks/${task._id}`, token(owner), {
        expectedVersion: 4,
        status: "in_progress",
      })
    ).statusCode,
    409,
  );
});

test("blocked work resumes and rejected review preserves ownership but clears obsolete result", async () => {
  const { prefix, owner, reviewer } = await fixture();
  const task = await newTask(prefix, owner);
  await call("POST", `${prefix}/tasks/${task._id}/claim`, token(owner));
  assert.equal(
    (
      await call("PATCH", `${prefix}/tasks/${task._id}`, token(owner), {
        expectedVersion: 2,
        status: "blocked",
        reason: "Need interface",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("PATCH", `${prefix}/tasks/${task._id}`, token(owner), {
        expectedVersion: 3,
        status: "in_progress",
      })
    ).statusCode,
    200,
  );
  const result = { commit: "c".repeat(40), summary: "Candidate", verification: "Tests run" };
  assert.equal(
    (
      await call("PATCH", `${prefix}/tasks/${task._id}`, token(owner), {
        expectedVersion: 4,
        status: "in_review",
        reviewerId: owner,
        result,
      })
    ).statusCode,
    403,
  );
  await call("PATCH", `${prefix}/tasks/${task._id}`, token(owner), {
    expectedVersion: 4,
    status: "in_review",
    reviewerId: reviewer,
    result,
  });
  const returned = await call("PATCH", `${prefix}/tasks/${task._id}`, token(reviewer), {
    expectedVersion: 5,
    status: "in_progress",
    reason: "Missing test",
  });
  assert.equal(returned.statusCode, 200);
  const state = returned.json<Task>();
  assert.equal(state.ownerId, owner);
  assert.equal(state.result, undefined);
  assert.equal(state.reviewerId, null);
  const audit = await store.events.find({ entityId: task._id, kind: "task.updated" }).toArray();
  assert.ok(
    audit.some((e) => (e.details.result as { commit?: string } | null)?.commit === result.commit),
  );
  assert.ok(audit.some((e) => e.details.reason === "Missing test"));
});

test("concurrent duplicate messages persist one message, delivery and wakeup; mismatched reuse fails", async () => {
  const { prefix, runId, owner, reviewer } = await fixture();
  const dm = (
    await call("POST", `${prefix}/channels/dm`, token(owner), { peerId: reviewer })
  ).json<Channel>();
  const input = { requestId: "same-request", body: "Please review", mentions: [] };
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      call("POST", `${prefix}/channels/${dm._id}/messages`, token(owner), input),
    ),
  );
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  const message = responses[0]?.json<Message>();
  assert.ok(message);
  assert.ok(responses.every((r) => r.json<Message>()._id === message._id));
  assert.equal(await store.messages.countDocuments({ runId }), 1);
  assert.equal(await store.deliveries.countDocuments({ messageId: message._id }), 1);
  assert.equal(await store.outbox.countDocuments({ runId }), 1);
  assert.equal((await store.channels.findOne({ _id: dm._id }))?.nextSequence, 1);
  assert.equal(
    (
      await call("POST", `${prefix}/channels/${dm._id}/messages`, token(owner), {
        ...input,
        body: "Different content",
      })
    ).statusCode,
    409,
  );
  const inbox = (await call("GET", `${prefix}/inbox`, token(reviewer))).json<{
    items: { messageId: string }[];
  }>();
  assert.equal(inbox.items[0]?.messageId, message._id);
  const delivery = await store.deliveries.findOne({ messageId: message._id });
  assert.ok(delivery);
  const fetched = await call(
    "GET",
    `${prefix}/channels/${delivery.channelId}/messages?after=${delivery.sequence - 1}&limit=1`,
    token(reviewer),
  );
  assert.equal(fetched.json<{ items: Message[] }>().items[0]?._id, message._id);
});

test("group messages wake only explicit recipients and channel history is paginated in order", async () => {
  const { prefix, runId, owner, reviewer, peer, team } = await fixture();
  const path = `${prefix}/channels/${team._id}/messages`;
  const first = await call("POST", path, token(owner), {
    requestId: "broadcast",
    body: "FYI",
    mentions: [],
  });
  assert.equal(first.statusCode, 200);
  assert.equal(await store.deliveries.countDocuments({ runId }), 0);
  await call("POST", path, token(owner), {
    requestId: "mention",
    body: "Question",
    mentions: [reviewer],
  });
  assert.equal(await store.deliveries.countDocuments({ runId }), 1);
  const page1 = (await call("GET", `${path}?limit=1`, token(peer))).json<{
    items: Message[];
    nextAfter: number;
  }>();
  assert.equal(page1.items[0]?.body, "FYI");
  assert.equal(page1.nextAfter, 1);
  const page2 = (await call("GET", `${path}?after=${page1.nextAfter}`, token(peer))).json<{
    items: Message[];
  }>();
  assert.equal(page2.items.length, 1);
  assert.equal(page2.items[0]?.body, "Question");
  assert.equal(
    (await call("GET", `${prefix}/inbox`, token(peer))).json<{ items: unknown[] }>().items.length,
    0,
  );
});

test("DM membership and run boundaries apply to reads, writes, replies and credentials", async () => {
  const a = await fixture();
  const b = await fixture();
  const dm = (
    await call("POST", `${a.prefix}/channels/dm`, token(a.owner), { peerId: a.reviewer })
  ).json<Channel>();
  const reversed = (
    await call("POST", `${a.prefix}/channels/dm`, token(a.reviewer), { peerId: a.owner })
  ).json<Channel>();
  assert.equal(reversed._id, dm._id);
  const url = `${a.prefix}/channels/${dm._id}/messages`;
  assert.equal((await call("GET", url, token(a.peer))).statusCode, 404);
  assert.equal(
    (await call("POST", url, token(a.peer), { requestId: "intrusion", body: "Hello" })).statusCode,
    404,
  );
  assert.equal((await call("GET", `${a.prefix}/tasks`, token(b.owner))).statusCode, 401);
  assert.equal(
    (await call("POST", `${a.prefix}/channels/dm`, token(a.owner), { peerId: b.owner })).statusCode,
    404,
  );
  assert.equal(
    (
      await call("POST", url, token(a.owner), {
        requestId: "invalid-mention",
        body: "Hello",
        mentions: [a.peer],
      })
    ).statusCode,
    400,
  );
  const hidden = (
    await call("POST", url, token(a.owner), { requestId: "private", body: "Private note" })
  ).json<Message>();
  assert.equal(
    (
      await call("POST", `${a.prefix}/channels/${a.team._id}/messages`, token(a.owner), {
        requestId: "bad-reply",
        body: "Leak",
        replyTo: hidden._id,
      })
    ).statusCode,
    400,
  );
  const agents = await call("GET", `${a.prefix}/agents`, token(a.owner));
  assert.ok(!agents.body.includes("tokenHash"));
  assert.ok(!agents.body.includes(token(a.owner)));
});

test("failure inserting the outbox rolls back the message, delivery and channel sequence", async () => {
  const { prefix, runId, owner, reviewer, team } = await fixture();
  // Fail one collection write using a real server validator, not a mocked transaction.
  await store.db.command({
    collMod: "outbox",
    validator: { runId: { $ne: runId } },
    validationLevel: "strict",
  });
  try {
    const response = await call("POST", `${prefix}/channels/${team._id}/messages`, token(owner), {
      requestId: "rollback",
      body: "Wake reviewer",
      mentions: [reviewer],
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json<{ error: string }>().error, "internal_error");
    assert.equal(await store.messages.countDocuments({ runId }), 0);
    assert.equal(await store.deliveries.countDocuments({ runId }), 0);
    assert.equal((await store.channels.findOne({ _id: team._id }))?.nextSequence, 0);
  } finally {
    await store.db.command({ collMod: "outbox", validator: {} });
  }
});

test("registered worker limit is atomic and duplicate registration does not consume capacity", async () => {
  const runId = randomUUID();
  const body = { objective: "Capacity", repository: "fixture://capacity", workerLimit: 1 };
  await call("PUT", `/admin/runs/${runId}`, admin, body);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const results = await Promise.all(
    ids.map((id) =>
      call("PUT", `/admin/runs/${runId}/agents/${id}`, admin, {
        role: "worker",
        kind: "worker",
        token: token(id),
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409]);
  const winner = results.find((r) => r.statusCode === 200)?.json<{ _id: string }>();
  assert.ok(winner);
  assert.equal(
    (
      await call("PUT", `/admin/runs/${runId}/agents/${winner._id}`, admin, {
        role: "worker",
        kind: "worker",
        token: token(winner._id),
      })
    ).statusCode,
    200,
  );
  assert.equal((await store.runs.findOne({ _id: runId }))?.workerCount, 1);
  const orchestratorId = randomUUID();
  assert.equal(
    (
      await call("PUT", `/admin/runs/${runId}/agents/${orchestratorId}`, admin, {
        role: "manager",
        kind: "orchestrator",
        token: token(orchestratorId),
      })
    ).statusCode,
    200,
  );
});

test("state survives a backend restart without relying on in-memory queues", async () => {
  const { prefix, owner, reviewer, team } = await fixture();
  const sent = (
    await call("POST", `${prefix}/channels/${team._id}/messages`, token(owner), {
      requestId: "restart",
      body: "Still pending",
      mentions: [reviewer],
    })
  ).json<Message>();
  const uri = process.env.TEST_MONGODB_URI ?? replica?.getUri();
  assert.ok(uri);
  const secondClient = await new MongoClient(uri).connect();
  const restarted = buildApp(
    new CoordinationStore(secondClient, secondClient.db(databaseName)),
    admin,
  );
  try {
    const response = await restarted.inject({
      method: "GET",
      url: `${prefix}/inbox`,
      headers: { authorization: `Bearer ${token(reviewer)}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<{ items: { messageId: string }[] }>().items[0]?.messageId, sent._id);
  } finally {
    await restarted.close();
    await secondClient.close();
  }
});

test("schema validation rejects spoofed identities and invalid input before mutations", async () => {
  const { prefix, owner, team } = await fixture();
  const response = await call("POST", `${prefix}/channels/${team._id}/messages`, token(owner), {
    requestId: "spoof",
    body: "Hello",
    senderId: "someone-else",
  });
  assert.equal(response.statusCode, 400);
  assert.equal((await call("GET", `${prefix}/tasks?limit=100000`, token(owner))).statusCode, 400);
  assert.equal(
    (
      await call("POST", `${prefix}/tasks`, token(owner), {
        requestId: "empty",
        title: " ",
        description: "x",
        acceptanceCriteria: ["ok"],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("PUT", "/admin/runs/forbidden", token(owner), {
        objective: "x",
        repository: "x",
        workerLimit: 1,
      })
    ).statusCode,
    401,
  );
});

test("task creation retries deduplicate, and conflicting concurrent edits reject stale state", async () => {
  const { prefix, owner } = await fixture();
  const tasks = await Promise.all(
    Array.from({ length: 5 }, () => newTask(prefix, owner, [], "same-task")),
  );
  const task = tasks[0];
  assert.ok(task);
  assert.ok(tasks.every((t) => t._id === task._id));
  const mismatch = await call("POST", `${prefix}/tasks`, token(owner), {
    requestId: "same-task",
    title: "Changed",
    description: "Different",
    acceptanceCriteria: ["Different"],
    dependencies: [],
  });
  assert.equal(mismatch.statusCode, 409);
  await call("POST", `${prefix}/tasks/${task._id}/claim`, token(owner));
  const edits = await Promise.all(
    ["Block A", "Block B"].map((reason) =>
      call("PATCH", `${prefix}/tasks/${task._id}`, token(owner), {
        expectedVersion: 2,
        status: "blocked",
        reason,
      }),
    ),
  );
  assert.deepEqual(edits.map((r) => r.statusCode).sort(), [200, 409]);
});

test("HTTP demo runs through the real listening API with explicitly synthetic evidence", async () => {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "scripts/demo.ts"],
    { env: { ...process.env, API_URL: address, ADMIN_TOKEN: admin }, timeout: 15000 },
  );
  const result = JSON.parse(stdout) as {
    runId: string;
    taskId: string;
    pendingDeliveries: number;
    mode: string;
  };
  assert.match(result.mode, /no agent/);
  assert.equal(result.pendingDeliveries, 1);
  assert.equal(
    (await store.tasks.findOne({ _id: result.taskId, runId: result.runId }))?.status,
    "done",
  );
});
