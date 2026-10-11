import { z } from "zod";
import type { AgentState, DashboardEvent, RunStatus, Task } from "../contract/events";
import { USER_ID } from "../contract/events";
import { initialState, type RunState } from "../state/reduce";

const identifier = z.string().min(1).max(128);
const date = z.iso.datetime({ offset: true });
const nullableText = z.string().nullable().optional();
const usage = z.object({
  input: z.number(),
  output: z.number(),
  cost: z.number(),
  elapsedMs: z.number(),
});
export const snapshotSchema = z.object({
  run: z.object({
    _id: identifier,
    objective: z.string(),
    repository: nullableText,
    workerLimit: z.number(),
    status: z.enum(["active", "completing", "stopping", "stopped", "completed", "failed"]),
    createdAt: date,
    endedAt: date.optional(),
    eventSequence: z.number().int().optional(),
    failure: nullableText,
    completion: z
      .object({
        finalCommit: nullableText,
        outcome: z.string(),
        evidence: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  agents: z.array(
    z.object({
      _id: identifier,
      role: z.string(),
      kind: z.enum(["orchestrator", "worker"]),
      status: z.enum(["pending", "idle", "running", "needs_inspection", "stopped"]),
      generation: z.number().int(),
      createdAt: date,
      sandboxId: nullableText,
      cleanupCompletedAt: date.nullable().optional(),
      checkpointId: nullableText,
      invocationId: nullableText,
    }),
  ),
  tasks: z.array(
    z.object({
      _id: identifier,
      title: z.string(),
      description: z.string(),
      acceptanceCriteria: z.array(z.string()),
      dependencies: z.array(z.string()),
      status: z.enum(["open", "in_progress", "blocked", "in_review", "done"]),
      ownerId: nullableText,
      createdBy: identifier,
      result: z
        .object({
          commit: nullableText,
          summary: z.string(),
          verification: nullableText,
          evidence: z.array(z.string()).optional(),
        })
        .optional(),
      review: z.object({ commit: nullableText, verification: z.string() }).optional(),
    }),
  ),
  channels: z.array(
    z.object({ _id: identifier, kind: z.enum(["team", "dm"]), participants: z.array(z.string()) }),
  ),
  messages: z.array(
    z.object({
      _id: identifier,
      channelId: identifier,
      senderId: identifier,
      recipients: z.array(z.string()),
      body: z.string(),
      requestId: z.string(),
      createdAt: date,
      sequence: z.number(),
      replyTo: z.string().optional(),
    }),
  ),
  invocations: z.array(
    z.object({ agentId: identifier, status: z.string(), result: z.object({ usage }).optional() }),
  ),
});
export type BackendSnapshot = z.infer<typeof snapshotSchema>;
export type BackendMessage = BackendSnapshot["messages"][number];
export const activitySchema = z.object({
  _id: identifier,
  runId: identifier,
  agentId: identifier,
  entityId: identifier,
  generation: z.number().int(),
  sequence: z.number().int().positive(),
  type: z.string(),
  payload: z.unknown(),
  createdAt: date,
});
export type BackendActivity = z.infer<typeof activitySchema>;
export const participant = (value: string) => (value === "operator" ? USER_ID : value);
export const runStatus = (value: BackendSnapshot["run"]["status"]): RunStatus =>
  value === "active" ? "running" : value === "stopped" ? "cancelled" : value;
export const agentStatus = (value: string): AgentState =>
  value === "pending" ? "provisioning" : value === "idle" ? "waiting" : (value as AgentState);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const summary = (value: unknown) =>
  (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).slice(0, 1400);

export function taskView(task: BackendSnapshot["tasks"][number]): Task {
  return {
    id: task._id,
    title: task.title,
    description: task.description,
    acceptance: task.acceptanceCriteria,
    dependsOn: task.dependencies,
    status: task.status,
    ownerId: task.ownerId ?? undefined,
    resultCommit: task.result?.commit ?? undefined,
    resultSummary: task.result?.summary,
    verification: task.review?.verification ?? task.result?.verification ?? undefined,
    evidence: task.result?.evidence,
  };
}

// Render records derive from persisted backend events. Their sequence is separate
// from the raw SSE replay cursor: one invocation can expose state, usage and checkpoint.
export function projectActivity(
  event: BackendActivity,
  snapshot: BackendSnapshot,
  message?: BackendMessage,
): DashboardEvent[] {
  const p = object(event.payload);
  const base = {
    seq: event.sequence * 10,
    ts: event.createdAt,
    runId: event.runId,
    agentId:
      event.agentId === "operator" || event.agentId === "harness" ? undefined : event.agentId,
  };
  const add = (payload: Record<string, unknown>, offset = 0) =>
    ({ ...base, ...payload, seq: base.seq + offset }) as DashboardEvent;
  switch (event.type) {
    case "run.started":
      return [
        add({
          type: "run.state",
          status: "starting",
          objective: snapshot.run.objective,
          repo: snapshot.run.repository ?? undefined,
          workerLimit: snapshot.run.workerLimit,
        }),
      ];
    case "run.completion_requested":
      return [
        add({
          type: "run.state",
          status: "completing",
          outcome: p.outcome,
          finalCommit: p.finalCommit ?? undefined,
        }),
      ];
    case "run.stopping":
      return [add({ type: "run.state", status: "stopping" })];
    case "run.finished":
      return [
        add({
          type: "run.state",
          status: runStatus(p.status as BackendSnapshot["run"]["status"]),
          outcome: p.outcome ?? snapshot.run.completion?.outcome,
          finalCommit: p.finalCommit ?? undefined,
        }),
      ];
    case "agent.spawned": {
      const agent = object(p.agent);
      return [
        add({
          type: "agent.spawned",
          agentId: event.entityId,
          role: agent.role,
          kind: agent.kind,
          spawnedBy: event.agentId === "operator" ? undefined : event.agentId,
        }),
      ];
    }
    case "agent.registered":
      return [];
    case "message.sent": {
      if (!message) throw new Error("Message reference not resolved");
      const channel = snapshot.channels.find((c) => c._id === message.channelId);
      if (!channel) throw new Error("Channel reference not resolved");
      const to =
        channel.kind === "dm"
          ? channel.participants.filter((id) => id !== message.senderId)
          : message.recipients;
      return [
        add({
          type: "message.sent",
          agentId: undefined,
          messageId: message._id,
          channelId: message.channelId,
          channelKind: channel.kind,
          from: participant(message.senderId),
          to: to.map(participant),
          body: message.body,
          clientRequestId: message.requestId,
          replyTo: message.replyTo,
        }),
      ];
    }
    case "task.created":
    case "task.claimed":
    case "task.updated": {
      const task = snapshot.tasks.find((t) => t._id === event.entityId);
      if (!task) throw new Error("Task reference not resolved");
      const view = taskView(task);
      if (event.type === "task.created") {
        view.status = "open";
        view.ownerId = undefined;
        view.resultCommit = undefined;
        view.resultSummary = undefined;
      } else if (event.type === "task.claimed") {
        view.status = "in_progress";
        view.ownerId = event.agentId;
        view.resultCommit = undefined;
        view.resultSummary = undefined;
      } else {
        view.status = p.to as Task["status"];
        if (p.result) {
          const result = object(p.result);
          view.resultCommit = typeof result.commit === "string" ? result.commit : undefined;
          view.resultSummary = String(result.summary ?? "");
          view.verification =
            typeof result.verification === "string" ? result.verification : undefined;
        }
      }
      return [add({ type: "task.upserted", taskId: task._id, task: view })];
    }
    case "invocation_started":
      return [
        add({
          type: "agent.state",
          state: "running",
          generation: event.generation,
          invocationId: p.invocationId,
        }),
      ];
    case "invocation_finished": {
      const u = object(p.usage);
      return [
        add({
          type: "agent.state",
          state: agentStatus(String(p.status)),
          generation: event.generation,
        }),
        add(
          {
            type: "usage",
            invocationId: event.entityId,
            inputTokens: Number(u.input ?? 0),
            outputTokens: Number(u.output ?? 0),
            costUsd: Number(u.cost ?? 0),
            durationMs: Number(u.elapsedMs ?? 0),
          },
          1,
        ),
        add({ type: "checkpoint", action: "saved", version: event.generation }, 2),
      ];
    }
    case "agent_stopped":
      return [add({ type: "agent.state", state: "stopped", generation: event.generation })];
    case "agent.wakeup_scheduled":
      return [
        add({
          type: "tool.called",
          tool: "scheduled follow-up",
          summary: `${p.wakeAt}: ${p.note}`,
        }),
      ];
    case "agent.timer_fired":
      return [add({ type: "agent.woken", reason: "timer" })];
    case "invocation_uncertain":
    case "agent_failed":
    case "agent.budget_exhausted":
      return [
        add({
          type: "failure.recorded",
          failureId: event._id,
          scope: "invocation",
          message: String(p.error ?? "Invocation budget exhausted"),
          resolved: false,
        }),
      ];
    case "tool_execution_start":
      return [
        add({
          type: "tool.called",
          tool: String(p.toolName ?? "tool"),
          summary: summary(p.args),
          invocationId: event.entityId,
        }),
      ];
    case "tool_execution_end":
      return [
        add({
          type: "tool.called",
          tool: `${String(p.toolName ?? "tool")} ${p.isError ? "error" : "result"}`,
          summary: summary(p.result),
          invocationId: event.entityId,
        }),
      ];
    case "work_log":
      return [
        add({
          type: "tool.called",
          tool: "working note",
          summary: String(p.note ?? ""),
          invocationId: event.entityId,
        }),
      ];
    case "message_end": {
      const m = object(p.message);
      if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
      const text = m.content
        .filter((c) => object(c).type === "text")
        .map((c) => String(object(c).text ?? ""))
        .join("\n");
      return text
        ? [
            add({
              type: "tool.called",
              tool: "response",
              summary: text.slice(0, 16000),
              invocationId: event.entityId,
            }),
          ]
        : [];
    }
    default:
      return [];
  }
}

export function overlaySnapshot(state: RunState, snapshot: BackendSnapshot): RunState {
  const next = {
    ...state,
    agents: { ...state.agents },
    tasks: { ...state.tasks },
    run: {
      ...state.run,
      status: runStatus(snapshot.run.status),
      objective: snapshot.run.objective,
      repo: snapshot.run.repository ?? undefined,
      workerLimit: snapshot.run.workerLimit,
      startedAt: snapshot.run.createdAt,
      endedAt: snapshot.run.endedAt,
      outcome: snapshot.run.completion?.outcome,
      finalCommit: snapshot.run.completion?.finalCommit ?? undefined,
    },
  };
  for (const agent of snapshot.agents) {
    const old = state.agents[agent._id];
    const sandbox = agent.sandboxId
      ? {
          id: agent.sandboxId,
          state: "running" as const,
          previousIds: old?.sandbox?.previousIds ?? [],
        }
      : old?.sandbox && agent.cleanupCompletedAt
        ? { ...old.sandbox, state: "terminated" as const }
        : old?.sandbox;
    next.agents[agent._id] = {
      id: agent._id,
      role: agent.role,
      kind: agent.kind,
      spawned: true,
      joinedSeq: old?.joinedSeq ?? 0,
      joinedTs: agent.createdAt,
      stateSince: old?.stateSince ?? agent.createdAt,
      pendingDeliveries: [],
      tools: [],
      wakes: [],
      stateHistory: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
      ...old,
      state:
        agent.status === "running" && !agent.sandboxId ? "provisioning" : agentStatus(agent.status),
      generation: agent.generation,
      invocationId: agent.invocationId ?? undefined,
      sandbox,
    };
  }
  next.agentOrder = snapshot.agents
    .slice()
    .sort(
      (a, b) =>
        Number(b.kind === "orchestrator") - Number(a.kind === "orchestrator") ||
        a.createdAt.localeCompare(b.createdAt),
    )
    .map((a) => a._id);
  for (const task of snapshot.tasks)
    next.tasks[task._id] = {
      createdSeq: state.tasks[task._id]?.createdSeq ?? 0,
      createdBy: task.createdBy,
      history: state.tasks[task._id]?.history ?? [],
      ...taskView(task),
    };
  return next;
}
export const emptyBackendState = (runId: string) => initialState(runId);
