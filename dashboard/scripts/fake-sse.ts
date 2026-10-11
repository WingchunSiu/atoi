// A local mock backend that streams a fixture over SSE and accepts operator messages,
// implementing the endpoints the dashboard uses:
//   GET  /api/runs                    → { runs: [{ id, objective, status, startedAt, mock: true }] }
//   GET  /api/runs/:runId/events      → SSE, honoring Last-Event-ID and ?after=<seq>
//   POST /api/runs/:runId/messages    → 202 { messageId }  (the orchestrator's reply is scripted)
//
// usage: npm run fake-sse -- --fixture recovery --speed 4 [--drop-after 30] [--port 8787]
//
// Pacing starts when the first client opens the event stream.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { FIXTURES } from "../fixtures/index";
import { sendMessageRequestSchema } from "../src/contract/events";
import { MockRun, type RawEvent } from "../src/sources/mockRun";

const { values: args } = parseArgs({
  options: {
    fixture: { type: "string", default: "happy-path" },
    speed: { type: "string", default: "1" },
    "drop-after": { type: "string" },
    port: { type: "string", default: "8787" },
  },
});

const build = FIXTURES[args.fixture!];
if (!build) {
  console.error(
    `Unknown fixture "${args.fixture}". Choose one of: ${Object.keys(FIXTURES).join(", ")}`,
  );
  process.exit(1);
}
const dropAfter = args["drop-after"] ? Number(args["drop-after"]) : undefined;
const run = new MockRun(build().events as RawEvent[], Number(args.speed) || 1);

type Client = { res: ServerResponse; sent: number };
const clients = new Set<Client>();

function send(client: Client, e: { seq: number }) {
  client.res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  client.sent += 1;
  if (dropAfter !== undefined && client.sent >= dropAfter) {
    console.log(`  dropping a connection after ${client.sent} events (--drop-after)`);
    clients.delete(client);
    client.res.end();
  }
}

run.onEvent((e) => {
  for (const c of [...clients]) send(c, e);
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleEvents(req: IncomingMessage, res: ServerResponse, url: URL) {
  const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 1000\n\n");
  const client: Client = { res, sent: 0 };
  clients.add(client);
  console.log(`  client connected after seq ${after}`);
  for (const e of run.events) {
    if (e.seq > after && clients.has(client)) send(client, e);
  }
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
  });
  run.start();
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || "{}");
}

async function handleMessage(req: IncomingMessage, res: ServerResponse) {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "Body must be JSON." });
  }
  const parsed = sendMessageRequestSchema.safeParse(body);
  if (!parsed.success)
    return json(res, 400, { error: parsed.error.issues.map((i) => i.message).join("; ") });
  const result = run.send(parsed.data);
  if (!result.ok) return json(res, result.status ?? 400, { error: result.error });
  console.log(`  operator → ${parsed.data.to}: ${parsed.data.body.slice(0, 60)}`);
  json(res, 202, { messageId: result.messageId });
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/api/runs" && req.method === "GET") {
    return json(res, 200, {
      runs: [
        {
          id: run.runId,
          objective: run.objective,
          status: run.runStatus ?? "starting",
          startedAt: run.events[0]?.ts ?? new Date().toISOString(),
          mock: true,
        },
      ],
    });
  }
  const m = url.pathname.match(/^\/api\/runs\/([^/]+)\/(events|messages)$/);
  if (m) {
    if (decodeURIComponent(m[1]!) !== run.runId)
      return json(res, 404, { error: `Run ${m[1]} not found.` });
    if (m[2] === "events" && req.method === "GET") return handleEvents(req, res, url);
    if (m[2] === "messages" && req.method === "POST") return void handleMessage(req, res);
    return json(res, 405, { error: "Method not allowed." });
  }
  json(res, 404, { error: "Not found." });
}).listen(Number(args.port), () => {
  console.log(
    `fake-sse: fixture "${args.fixture}" as run ${run.runId} on http://localhost:${args.port}`,
  );
  console.log("  open the dashboard with ?source=live (npm run dev proxies /api here)");
});
