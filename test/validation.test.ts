import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MongoClient } from "mongodb";
import { buildApp } from "../src/app.js";
import { CoordinationStore } from "../src/store.js";

// Deliberately disconnected: these contract checks must never reach MongoDB.
const client = new MongoClient("mongodb://127.0.0.1:1", { serverSelectionTimeoutMS: 10 });
const app = buildApp(
  new CoordinationStore(client, client.db("offline_contract")),
  "offline-admin-".repeat(4),
);
after(async () => {
  await app.close();
  await client.close();
});

test("offline liveness is explicitly coordination-only", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ mode: string }>().mode, "coordination-only");
});
test("missing credentials fail before database access", async () => {
  const response = await app.inject({ method: "GET", url: "/runs/fixture/tasks" });
  assert.equal(response.statusCode, 401);
});
test("client-supplied identity and MongoDB operators are rejected by request schemas", async () => {
  for (const payload of [
    { requestId: "r1", body: "hi", senderId: "impersonated" },
    { requestId: { $ne: null }, body: "hi" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/runs/fixture/channels/team/messages",
      payload,
    });
    assert.equal(response.statusCode, 400);
  }
});
test("a weak operator credential is rejected at startup", () => {
  assert.throws(
    () => buildApp(new CoordinationStore(client, client.db("offline_contract")), "short"),
    /at least 32/,
  );
});
