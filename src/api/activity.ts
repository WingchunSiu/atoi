import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HarnessError, id } from "../contracts/runtime.js";
import type { MongoStore } from "../store/mongo.js";

function activityView(event: {
  _id: string;
  runId: string;
  actorId: string;
  entityId: string;
  kind: string;
  details: Record<string, unknown>;
  sequence: number;
  createdAt: Date;
  generation?: number;
  sessionId?: string;
}) {
  return {
    _id: event._id,
    runId: event.runId,
    agentId: event.actorId,
    entityId: event.entityId,
    invocationId:
      typeof event.details.invocationId === "string" ? event.details.invocationId : undefined,
    type: event.kind,
    payload: event.details.payload ?? event.details,
    sequence: event.sequence,
    createdAt: event.createdAt,
    generation: event.generation ?? 0,
    sessionId: event.sessionId,
  };
}
const cursor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const querySchema = z.object({
  agentId: id.optional(),
  after: cursor.default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  type: z.string().min(1).max(100).optional(),
});

export function activityRoutes(app: FastifyInstance, store: MongoStore) {
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const close of streams) close();
  });
  app.get("/runs", async () =>
    store.runs
      .find({ archivedAt: { $exists: false } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(30)
      .toArray(),
  );

  async function scope(runId: string, agentId?: string) {
    const run = await store.getRun(runId);
    if (agentId && (await store.getAgent(agentId)).runId !== runId)
      throw new HarnessError(404, "Agent not found in this run");
    return run;
  }

  async function page(runId: string, query: z.infer<typeof querySchema>) {
    const events = await store.events
      .find(
        {
          runId,
          sequence: { $gt: query.after },
          ...(query.agentId ? { actorId: query.agentId } : {}),
          ...(query.type ? { kind: query.type } : {}),
        },
        { readConcern: { level: "majority" }, projection: { requestHash: 0 } },
      )
      .sort({ sequence: 1 })
      .limit(query.limit + 1)
      .toArray();
    const hasMore = events.length > query.limit;
    if (hasMore) events.pop();
    return {
      events: events.map(activityView),
      cursor: events.at(-1)?.sequence ?? query.after,
      hasMore,
    };
  }

  app.get("/runs/:runId/agents/:agentId", async (request) => {
    const { runId, agentId } = z.object({ runId: id, agentId: id }).parse(request.params);
    await scope(runId, agentId);
    return {
      agent: await store.agents.findOne({ _id: agentId }, { projection: { tokenHash: 0 } }),
      tasks: await store.tasks.find({ runId, ownerId: agentId }).limit(50).toArray(),
      lastActivity: await store.events
        .find({ runId, actorId: agentId }, { projection: { requestHash: 0 } })
        .sort({ sequence: -1 })
        .limit(1)
        .next()
        .then((event) => (event ? activityView(event) : null)),
      invocations: await store.invocations
        .find({ agentId }, { projection: { prompt: 0 } })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
    };
  });

  app.get("/runs/:runId/events", async (request) => {
    const { runId } = z.object({ runId: id }).parse(request.params);
    const query = querySchema.parse(request.query);
    const run = await scope(runId, query.agentId);
    if (query.after > (run.eventSequence ?? 0))
      throw new HarnessError(400, "Cursor is ahead of this run");
    return page(runId, query);
  });

  app.get("/runs/:runId/events/stream", async (request, reply) => {
    const { runId } = z.object({ runId: id }).parse(request.params);
    const query = querySchema.parse(request.query);
    const lastId = request.headers["last-event-id"];
    if (lastId !== undefined) query.after = Math.max(query.after, cursor.parse(lastId));
    const run = await scope(runId, query.agentId);
    if (query.after > (run.eventSequence ?? 0))
      throw new HarnessError(400, "Cursor is ahead of this run");
    if (streams.size >= 50)
      throw new HarnessError(503, "Activity stream capacity reached; retry later");
    const first = await page(runId, query); // Fail before sending headers if Atlas is unavailable.
    const abort = new AbortController();
    const close = () => {
      abort.abort();
      reply.raw.end();
    };
    streams.add(close);
    reply.raw.once("close", () => abort.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    async function write(frame: string) {
      if (abort.signal.aborted) return;
      if (!reply.raw.write(frame)) {
        // Bound a slow reader instead of retaining an unbounded transcript in RAM.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error("Slow activity reader")), 10000);
          const finish = (error?: Error) => {
            clearTimeout(timer);
            reply.raw.off("drain", drained);
            abort.signal.removeEventListener("abort", closed);
            if (error) reject(error);
            else resolve();
          };
          const drained = () => finish();
          const closed = () => finish();
          reply.raw.once("drain", drained);
          abort.signal.addEventListener("abort", closed, { once: true });
        });
      }
    }
    try {
      await write(": connected\nretry: 1000\n\n");
      let batch = first;
      let heartbeat = Date.now();
      while (!abort.signal.aborted) {
        for (const event of batch.events) {
          await write(`id: ${event.sequence}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`);
          query.after = event.sequence;
        }
        if (!batch.hasMore) {
          if (Date.now() - heartbeat >= 15000) {
            await write(": heartbeat\n\n");
            heartbeat = Date.now();
          }
          await delay(500, undefined, { signal: abort.signal });
        }
        batch = await page(runId, query);
      }
    } catch {
      if (!abort.signal.aborted && !reply.raw.destroyed)
        reply.raw.write(
          'event: stream_error\ndata: {"error":"Activity source unavailable; reconnecting"}\n\n',
        );
    } finally {
      streams.delete(close);
      close();
    }
  });
}
