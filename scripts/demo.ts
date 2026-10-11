import { randomBytes, randomUUID } from "node:crypto";

const base = process.env.API_URL ?? "http://127.0.0.1:3000";
const admin = process.env.ADMIN_TOKEN;
if (!admin) throw new Error("ADMIN_TOKEN is required");
const runId = `demo-${randomUUID()}`;
const implementer = `impl-${randomUUID()}`;
const reviewer = `review-${randomUUID()}`;
const implementerToken = randomBytes(32).toString("hex");
const reviewerToken = randomBytes(32).toString("hex");
async function api<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status})`);
  return response.json() as Promise<T>;
}
await api(admin, `/admin/runs/${runId}`, "PUT", {
  objective: "Coordination API smoke test",
  repository: "fixture://coordination-only",
  workerLimit: 2,
});
for (const [agentId, token, role] of [
  [implementer, implementerToken, "implementer"],
  [reviewer, reviewerToken, "reviewer"],
]) {
  await api(admin, `/admin/runs/${runId}/agents/${agentId}`, "PUT", {
    role,
    kind: "worker",
    token,
  });
}
const task = await api<{ _id: string }>(implementerToken, `/runs/${runId}/tasks`, "POST", {
  requestId: "demo-task",
  title: "Review fixture change",
  description: "Exercise shared-state transitions without a model or Git execution.",
  acceptanceCriteria: ["Receive the peer request"],
  dependencies: [],
});
await api(implementerToken, `/runs/${runId}/tasks/${task._id}/claim`, "POST");
const channel = await api<{ _id: string }>(implementerToken, `/runs/${runId}/channels/dm`, "POST", {
  peerId: reviewer,
});
const message = await api<{ _id: string }>(
  implementerToken,
  `/runs/${runId}/channels/${channel._id}/messages`,
  "POST",
  { requestId: "review-request", body: `Please review task ${task._id}`, mentions: [] },
);
const inbox = await api<{ items: unknown[] }>(reviewerToken, `/runs/${runId}/inbox`);
if (inbox.items.length !== 1) throw new Error("Expected one pending review delivery");
// Synthetic evidence only: this script does not claim to execute Git or tests.
const fixtureCommit = "a".repeat(40);
await api(implementerToken, `/runs/${runId}/tasks/${task._id}`, "PATCH", {
  expectedVersion: 2,
  status: "in_review",
  reviewerId: reviewer,
  result: {
    commit: fixtureCommit,
    summary: "Synthetic demo candidate",
    verification: "Fixture text; no tests executed",
  },
});
await api(reviewerToken, `/runs/${runId}/tasks/${task._id}`, "PATCH", {
  expectedVersion: 3,
  status: "done",
  review: { commit: fixtureCommit, verification: "Synthetic approval; no tests executed" },
});
console.log(
  JSON.stringify(
    {
      mode: "coordination-only; no agent, sandbox or Git execution",
      runId,
      taskId: task._id,
      messageId: message._id,
      pendingDeliveries: inbox.items.length,
    },
    null,
    2,
  ),
);
