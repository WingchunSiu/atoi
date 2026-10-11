import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { id } from "../contracts/runtime.js";
import type { AgentEvent, Message, Task } from "../model.js";
import type { MongoStore } from "../store/mongo.js";

const domainTypes = new Set([
  "run.state",
  "agent.spawned",
  "agent.state",
  "sandbox.state",
  "checkpoint",
  "usage",
  "failure.recorded",
  "delivery.queued",
  "delivery.done",
  "worker.restarted",
]);

// Translate durable domain events, never infer a Git push or successful test from model prose.
export function dashboardEvent(event: AgentEvent): Record<string, unknown> | null {
  const envelope = {
    seq: event.sequence,
    ts: event.createdAt.toISOString(),
    runId: event.runId,
    agentId: event.actorId === "operator" ? undefined : event.actorId,
  };
  if (domainTypes.has(event.kind))
    return {
      ...envelope,
      type: event.kind,
      ...Object.fromEntries(Object.entries(event.details).filter(([, value]) => value != null)),
    };
  if (event.kind.startsWith("task.") && event.details.task) {
    const task = event.details.task as Task;
    return {
      ...envelope,
      type: "task.upserted",
      taskId: task._id,
      task: {
        id: task._id,
        title: task.title,
        description: task.description,
        acceptance: task.acceptanceCriteria,
        status: task.status,
        ownerId: task.ownerId ?? undefined,
        dependsOn: task.dependencies,
        resultCommit: task.result?.commit,
        verification: task.result?.verification,
        review: task.review?.verification,
      },
    };
  }
  if (event.kind === "message.sent" && event.details.message) {
    const message = event.details.message as Message;
    return {
      ...envelope,
      type: "message.sent",
      messageId: message._id,
      channelId: message.channelId,
      channelKind: event.details.channelKind,
      from: message.senderId === "operator" ? "user" : message.senderId,
      to: message.recipients.map((id) => (id === "operator" ? "user" : id)),
      body: message.body,
      replyTo: message.replyTo,
      clientRequestId: message.requestId,
    };
  }
  if (event.kind === "tool_execution_start") {
    const payload = event.details.payload as Record<string, unknown>;
    return {
      ...envelope,
      type: "tool.called",
      tool: String(payload.toolName ?? "tool"),
      summary: JSON.stringify(payload.args ?? {}).slice(0, 2000),
      invocationId: event.details.invocationId,
    };
  }
  if (event.kind === "work_log") {
    const payload = event.details.payload as Record<string, unknown>;
    return {
      ...envelope,
      type: "tool.called",
      tool: "work_log",
      summary: String(payload.note ?? ""),
      invocationId: event.details.invocationId,
    };
  }
  return null;
}

export function dashboardRoutes(app: FastifyInstance, store: MongoStore) {
  app.get("/operator/runs/:runId/dashboard-events", async (request) => {
    const { runId } = z.object({ runId: id }).parse(request.params);
    const { after, limit } = z
      .object({
        after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(request.query);
    await store.getRun(runId);
    const events = await store.events
      .find({ runId, sequence: { $gt: after } }, { readConcern: { level: "majority" } })
      .sort({ sequence: 1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = events.length > limit;
    if (hasMore) events.pop();
    return {
      events: events.map(dashboardEvent).filter(Boolean),
      cursor: events.at(-1)?.sequence ?? after,
      hasMore,
    };
  });
}
