// The atoi run event contract shared with the backend.
// Keep this file free of React and app imports so the backend can import or copy it.
import { z } from "zod";

export type AgentId = string;

/**
 * The human operator. Not an agent: it never spawns, sleeps or owns tasks, but it can DM the
 * orchestrator, and agents can reply to it. It appears in `from` and `to` of `message.sent`.
 */
export const USER_ID = "user";

export type RunStatus =
  | "starting"
  | "running"
  | "completing"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled";
export type AgentState =
  | "provisioning"
  | "waiting"
  | "running"
  | "checkpointing"
  | "recovering"
  | "needs_inspection"
  | "stopped"
  | "failed";
export type SandboxState = "starting" | "running" | "suspended" | "terminated";
export type TaskStatus = "open" | "in_progress" | "blocked" | "in_review" | "done";
export type WakeReason = "dm" | "mention" | "timer";
export type FailureScope = "provisioning" | "invocation" | "relay" | "recovery" | "cleanup";

export interface Task {
  id: string;
  title: string;
  description?: string;
  acceptance?: string[];
  status: TaskStatus;
  ownerId?: AgentId;
  dependsOn?: string[];
  resultCommit?: string;
  resultSummary?: string;
  verification?: string;
  evidence?: string[];
}

export interface Envelope {
  seq: number; // strictly increasing per run; SSE `id`
  ts: string; // ISO 8601
  runId: string;
  agentId?: AgentId; // the agent this event is about
  taskId?: string;
  causedBy?: string; // id of the message, timer or invocation that caused it
}

export type RunEvent = Envelope &
  (
    | {
        type: "run.state";
        status: RunStatus;
        objective?: string;
        repo?: string;
        workerLimit?: number;
        finalCommit?: string;
        outcome?: string;
      }
    | { type: "agent.spawned"; role: string; kind: "orchestrator" | "worker"; spawnedBy?: AgentId }
    | {
        type: "agent.state";
        state: AgentState;
        generation: number;
        invocationId?: string;
        wakeAt?: string;
        detail?: string;
      }
    | { type: "sandbox.state"; state: SandboxState; sandboxId: string }
    | { type: "agent.woken"; reason: WakeReason }
    | { type: "checkpoint"; action: "saved" | "restored"; version: number }
    | {
        type: "message.sent";
        messageId: string;
        channelId: string;
        channelKind: "team" | "dm";
        from: AgentId;
        to: AgentId[];
        body: string;
        replyTo?: string;
        clientRequestId?: string;
      }
    // `to` lists addressed agents: the DM peer, or @mentioned agents in the team channel.
    // A plain team message has `to: []`. `from`/`to` may be USER_ID for the operator's DM
    // with the orchestrator. `clientRequestId` echoes the id the dashboard sent with POST.
    | { type: "delivery.queued"; deliveryId: string; messageId: string } // agentId = recipient
    | { type: "delivery.done"; deliveryId: string; messageId: string } // agentId = recipient
    | { type: "task.upserted"; task: Task } // always the full task
    | { type: "tool.called"; tool: string; summary: string; invocationId?: string }
    | { type: "git.pushed"; branch: string; commit: string; message?: string }
    | {
        type: "verification.recorded";
        commit: string;
        command: string;
        passed: boolean;
        summary?: string;
      }
    | {
        type: "usage";
        invocationId?: string;
        model?: string;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        durationMs: number;
      }
    | { type: "worker.restarted" }
    | {
        type: "failure.recorded";
        failureId: string;
        scope: FailureScope;
        message: string;
        resolved: boolean;
      } // upsert by failureId
  );

export type RunEventType = RunEvent["type"];
export type EventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;

/** An event with a valid envelope but a `type` this dashboard doesn't know. Shown in the feed, ignored by the reducer. */
export type UnknownEvent = Envelope & { type: "unknown"; originalType: string };
export type DashboardEvent = RunEvent | UnknownEvent;

// ---------------------------------------------------------------------------
// zod schemas

const id = z.string().min(1);
const runStatus = z.enum([
  "starting",
  "running",
  "completing",
  "stopping",
  "completed",
  "failed",
  "cancelled",
]);
const agentState = z.enum([
  "provisioning",
  "waiting",
  "running",
  "checkpointing",
  "recovering",
  "needs_inspection",
  "stopped",
  "failed",
]);
const sandboxState = z.enum(["starting", "running", "suspended", "terminated"]);
const taskStatus = z.enum(["open", "in_progress", "blocked", "in_review", "done"]);
const wakeReason = z.enum(["dm", "mention", "timer"]);
const failureScope = z.enum(["provisioning", "invocation", "relay", "recovery", "cleanup"]);
const isoTime = z.iso.datetime({ offset: true });

export const taskSchema = z.object({
  id,
  title: z.string(),
  description: z.string().optional(),
  acceptance: z.array(z.string()).optional(),
  status: taskStatus,
  ownerId: id.optional(),
  dependsOn: z.array(id).optional(),
  resultCommit: z.string().optional(),
  resultSummary: z.string().optional(),
  verification: z.string().optional(),
  evidence: z.array(z.string()).optional(),
});

export const envelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: isoTime,
  runId: id,
  agentId: id.optional(),
  taskId: id.optional(),
  causedBy: id.optional(),
});

const payloadSchemas = {
  "run.state": z.object({
    status: runStatus,
    objective: z.string().optional(),
    repo: z.string().optional(),
    workerLimit: z.number().int().nonnegative().optional(),
    finalCommit: z.string().optional(),
    outcome: z.string().optional(),
  }),
  "agent.spawned": z.object({
    role: z.string().min(1),
    kind: z.enum(["orchestrator", "worker"]),
    spawnedBy: id.optional(),
  }),
  "agent.state": z.object({
    state: agentState,
    generation: z.number().int().nonnegative(),
    invocationId: id.optional(),
    wakeAt: isoTime.optional(),
    detail: z.string().optional(),
  }),
  "sandbox.state": z.object({ state: sandboxState, sandboxId: id }),
  "agent.woken": z.object({ reason: wakeReason }),
  checkpoint: z.object({
    action: z.enum(["saved", "restored"]),
    version: z.number().int().nonnegative(),
  }),
  "message.sent": z.object({
    messageId: id,
    channelId: id,
    channelKind: z.enum(["team", "dm"]),
    from: id,
    to: z.array(id),
    body: z.string(),
    replyTo: id.optional(),
    clientRequestId: id.optional(),
  }),
  "delivery.queued": z.object({ deliveryId: id, messageId: id }),
  "delivery.done": z.object({ deliveryId: id, messageId: id }),
  "task.upserted": z.object({ task: taskSchema }),
  "tool.called": z.object({
    tool: z.string().min(1),
    summary: z.string(),
    invocationId: id.optional(),
  }),
  "git.pushed": z.object({
    branch: z.string().min(1),
    commit: z.string().min(1),
    message: z.string().optional(),
  }),
  "verification.recorded": z.object({
    commit: z.string().min(1),
    command: z.string(),
    passed: z.boolean(),
    summary: z.string().optional(),
  }),
  usage: z.object({
    invocationId: id.optional(),
    model: z.string().optional(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
  "worker.restarted": z.object({}),
  "failure.recorded": z.object({
    failureId: id,
    scope: failureScope,
    message: z.string(),
    resolved: z.boolean(),
  }),
} satisfies Record<RunEventType, z.ZodObject>;

export const KNOWN_EVENT_TYPES = new Set<string>(Object.keys(payloadSchemas));

const typedEnvelope = envelopeSchema.extend({ type: z.string().min(1) });

export type ParseResult = { ok: true; event: DashboardEvent } | { ok: false; error: string };

/**
 * Validate one incoming event. The envelope is validated strictly; an unknown `type`
 * is kept as an UnknownEvent so a newer backend doesn't break an older dashboard.
 */
export function parseEvent(raw: unknown): ParseResult {
  const head = typedEnvelope.safeParse(raw);
  if (!head.success) return { ok: false, error: z.prettifyError(head.error) };
  const { type, ...envelope } = head.data;
  // Own keys only: `in` would also match Object.prototype names like "constructor".
  if (!Object.hasOwn(payloadSchemas, type)) {
    return { ok: true, event: { ...envelope, type: "unknown", originalType: type } };
  }
  const payload = payloadSchemas[type as RunEventType].safeParse(raw);
  if (!payload.success) return { ok: false, error: `${type}: ${z.prettifyError(payload.error)}` };
  return { ok: true, event: { ...envelope, ...payload.data, type } as RunEvent };
}

// Compile-time check that every payload schema matches the hand-written RunEvent type.
type PayloadOf<T extends RunEventType> = Omit<EventOf<T>, keyof Envelope | "type">;
type SchemaMatches = {
  [T in RunEventType]: z.infer<(typeof payloadSchemas)[T]> extends PayloadOf<T>
    ? PayloadOf<T> extends z.infer<(typeof payloadSchemas)[T]>
      ? true
      : T
    : T;
}[RunEventType];
const schemaMatches: SchemaMatches = true;
void schemaMatches;

// ---------------------------------------------------------------------------
// Operator messages
//
// POST /api/runs/:runId/messages  body: SendMessageRequest  → 202 SendMessageResponse
// The backend records the message like any DM (message.sent from USER_ID with the same
// clientRequestId, plus a delivery for the recipient) and wakes the recipient. The dashboard
// only shows the message as sent once that event arrives on the stream.

export interface SendMessageRequest {
  to: AgentId; // the orchestrator
  body: string;
  clientRequestId: string; // idempotency key; retries with the same id must not duplicate
}

export interface SendMessageResponse {
  messageId: string;
}

export const sendMessageRequestSchema = z.object({
  to: id,
  body: z.string().trim().min(1).max(8000),
  clientRequestId: id,
});

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
