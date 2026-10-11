import { randomUUID } from "node:crypto";
import { watchActivity } from "./client/activity.js";
import { id } from "./contracts/runtime.js";

const [command, ...args] = process.argv.slice(2);
const baseUrl = process.env.BACKEND_PUBLIC_URL ?? "http://localhost:3000";
const token = process.env.ADMIN_TOKEN;
if (!token) throw new Error("ADMIN_TOKEN is required");
if (command === "watch") {
  const runId = id.parse(args[0]);
  const agentId = args[1] ? id.parse(args[1]) : undefined;
  const after = args[2] === undefined ? 0 : Number(args[2]);
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error("Cursor must be a nonnegative integer");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await watchActivity({
      baseUrl,
      token,
      runId,
      agentId,
      after,
      signal: controller.signal,
      onEvent: (event) => {
        console.log(JSON.stringify(event));
      },
      onConnection: (state, error) => {
        console.error(`Activity feed: ${state}${error ? ` — ${error}` : ""}`);
      },
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  process.exit(0);
}
let endpoint: string;
let body: unknown;
let method = "GET";
switch (command) {
  case "start": {
    const [repositoryUrl, objective] = args;
    if (!repositoryUrl || !objective)
      throw new Error('Usage: pnpm cli start <https-git-url> "objective"');
    endpoint = "/operator/runs";
    method = "POST";
    body = {
      requestId: randomUUID(),
      repositoryUrl,
      objective,
      workerLimit: Number(args[2] ?? 2),
    };
    break;
  }
  case "agent":
    endpoint = `/operator/runs/${id.parse(args[0])}/agents/${id.parse(args[1])}`;
    break;
  case "history": {
    const runId = id.parse(args[0]);
    const query = new URLSearchParams();
    if (args[1]) query.set("agentId", id.parse(args[1]));
    if (args[2]) query.set("after", args[2]);
    endpoint = `/operator/runs/${runId}/events?${query}`;
    break;
  }
  case "status":
    endpoint = `/operator/runs/${args[0]}`;
    break;
  case "message":
    if (!args[0] || !args[1] || !args[2])
      throw new Error('Usage: pnpm cli message <runId> <agentId> "message"');
    endpoint = `/operator/runs/${args[0]}/messages`;
    method = "POST";
    body = { requestId: randomUUID(), recipientId: args[1], body: args[2] };
    break;
  case "stop":
    endpoint = `/operator/runs/${args[0]}/stop`;
    method = "POST";
    body = {};
    break;
  case "replace":
    if (!args[0] || !args[1] || !args[2])
      throw new Error("Usage: pnpm cli replace <runId> <agentId> <pushed-commit>");
    endpoint = `/operator/runs/${id.parse(args[0])}/agents/${id.parse(args[1])}/replace`;
    method = "POST";
    body = { requestId: randomUUID(), commit: args[2] };
    break;
  default:
    throw new Error("Commands: start, status, agent, history, watch, message, stop, replace");
}
const response = await fetch(new URL(endpoint, baseUrl), {
  method,
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Harness returned ${response.status}: ${await response.text()}`);
console.log(JSON.stringify(await response.json(), null, 2));
