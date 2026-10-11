import type {
  AgentId,
  AgentState,
  DashboardEvent,
  RunStatus,
  SandboxState,
  Task,
  TaskStatus,
  WakeReason,
} from "../contract/events";
import { TERMINAL_RUN_STATUSES, USER_ID } from "../contract/events";

export interface ToolCall {
  seq: number;
  ts: string;
  tool: string;
  summary: string;
}

export interface AgentView {
  id: AgentId;
  role: string;
  kind: "orchestrator" | "worker";
  spawnedBy?: AgentId;
  /** False while the agent only exists because another event named it. */
  spawned: boolean;
  joinedSeq: number;
  joinedTs: string;
  state: AgentState;
  stateSince: string;
  generation: number;
  invocationId?: string;
  wakeAt?: string;
  detail?: string;
  sandbox?: { id: string; state: SandboxState; previousIds: string[]; replacedAt?: string };
  pendingDeliveries: string[];
  lastTool?: { tool: string; summary: string; ts: string };
  /** The most recent tool calls, newest last, capped at TOOL_HISTORY. */
  tools: ToolCall[];
  lastWake?: { reason: WakeReason; seq: number; ts: string; causedBy?: string };
  wakes: { reason: WakeReason; seq: number; ts: string; causedBy?: string }[];
  checkpointVersion?: number;
  stateHistory: {
    seq: number;
    ts: string;
    state: AgentState;
    generation: number;
    detail?: string;
  }[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    costKnown?: boolean;
  };
}

export interface TaskView extends Task {
  createdSeq: number;
  createdBy?: AgentId;
  history: {
    seq: number;
    ts: string;
    status: TaskStatus;
    ownerId?: AgentId;
    resultCommit?: string;
    by?: AgentId;
  }[];
}

export interface Message {
  id: string;
  seq: number;
  ts: string;
  channelId: string;
  channelKind: "team" | "dm";
  from: AgentId;
  to: AgentId[];
  body: string;
  replyTo?: string;
  clientRequestId?: string;
}

export interface Verification {
  seq: number;
  ts: string;
  agentId?: AgentId;
  command: string;
  passed: boolean;
  summary?: string;
}

export interface Commit {
  sha: string;
  branch?: string;
  agentId?: AgentId;
  ts?: string;
  message?: string;
  /** seq of the push, or of the first verification if the push hasn't arrived. */
  seq: number;
  pushed: boolean;
  verifications: Verification[];
}

export interface Failure {
  id: string;
  seq: number;
  ts: string;
  agentId?: AgentId;
  scope: string;
  message: string;
  resolved: boolean;
  updatedSeq: number;
}

export interface RunState {
  runId: string;
  run?: {
    status: RunStatus;
    objective?: string;
    repo?: string;
    workerLimit?: number;
    deadline?: string;
    startedAt?: string;
    endedAt?: string;
    finalCommit?: string;
    outcome?: string;
  };
  agents: Record<AgentId, AgentView>;
  agentOrder: AgentId[]; // orchestrator first, then by joinedSeq
  tasks: Record<string, TaskView>;
  messages: Message[];
  channels: Record<
    string,
    { id: string; kind: "team" | "dm"; members: AgentId[]; lastSeq: number; count: number }
  >;
  peerLinks: Record<
    string,
    { key: string; a: AgentId; b: AgentId; count: number; firstSeq: number; lastSeq: number }
  >;
  deliveries: Record<
    string,
    { id: string; messageId: string; agentId: AgentId; seq: number; done: boolean }
  >;
  commits: Record<string, Commit>;
  failures: Record<string, Failure>;
  workerRestarts: { seq: number; ts: string }[];
  sandboxReplacements: {
    seq: number;
    ts: string;
    agentId: AgentId;
    oldId: string;
    newId: string;
    generation: number;
  }[];
  firstTs?: string;
  lastTs?: string;
  lastSeq: number;
}

export const TOOL_HISTORY = 30;

export function initialState(runId = ""): RunState {
  return {
    runId,
    agents: {},
    agentOrder: [],
    tasks: {},
    messages: [],
    channels: {},
    peerLinks: {},
    deliveries: {},
    commits: {},
    failures: {},
    workerRestarts: [],
    sandboxReplacements: [],
    lastSeq: -1,
  };
}

export function peerKey(a: AgentId, b: AgentId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function placeholder(id: AgentId, seq: number, ts: string): AgentView {
  return {
    id,
    role: "unknown",
    kind: "worker",
    spawned: false,
    joinedSeq: seq,
    joinedTs: ts,
    state: "provisioning",
    stateSince: ts,
    generation: 0,
    pendingDeliveries: [],
    tools: [],
    wakes: [],
    stateHistory: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
  };
}

function orderAgents(agents: Record<AgentId, AgentView>): AgentId[] {
  return Object.values(agents)
    .sort((x, y) => {
      if (x.kind !== y.kind) return x.kind === "orchestrator" ? -1 : 1;
      return x.joinedSeq - y.joinedSeq;
    })
    .map((a) => a.id);
}

/** Make sure every named agent exists, creating "unknown" placeholders for out-of-order events. */
function ensureAgents(
  state: RunState,
  ids: (AgentId | undefined)[],
  seq: number,
  ts: string,
): RunState {
  let agents = state.agents;
  for (const id of ids) {
    // The operator is a chat participant, not an agent.
    if (!id || id === USER_ID || agents[id]) continue;
    if (agents === state.agents) agents = { ...agents };
    agents[id] = placeholder(id, seq, ts);
  }
  if (agents === state.agents) return state;
  return { ...state, agents, agentOrder: orderAgents(agents) };
}

function updateAgent(state: RunState, id: AgentId, fn: (a: AgentView) => AgentView): RunState {
  const agent = state.agents[id];
  if (!agent) return state;
  return { ...state, agents: { ...state.agents, [id]: fn(agent) } };
}

/** Pure fold step. The only write path into run state. */
export function reduce(prev: RunState, event: DashboardEvent): RunState {
  if (event.seq <= prev.lastSeq) return prev;
  let state: RunState = {
    ...prev,
    runId: prev.runId || event.runId,
    lastSeq: event.seq,
    lastTs: event.ts,
    firstTs: prev.firstTs ?? event.ts,
  };
  if (event.type === "unknown") return state;

  const named =
    event.type === "message.sent" ? [event.agentId, event.from, ...event.to] : [event.agentId];
  state = ensureAgents(state, named, event.seq, event.ts);
  return apply(state, event);
}

type Handler<T extends DashboardEvent["type"]> = (
  s: RunState,
  e: Extract<DashboardEvent, { type: T }>,
) => RunState;

function apply(s: RunState, e: DashboardEvent): RunState {
  const handler = handlers[e.type] as Handler<typeof e.type> | undefined;
  return handler ? handler(s, e as never) : s;
}

const handlers: { [T in DashboardEvent["type"]]?: Handler<T> } = {
  "run.state": (s, e) => {
    const run = { ...(s.run ?? { status: e.status }) };
    run.status = e.status;
    if (e.objective !== undefined) run.objective = e.objective;
    if (e.repo !== undefined) run.repo = e.repo;
    if (e.workerLimit !== undefined) run.workerLimit = e.workerLimit;
    if (e.deadline !== undefined) run.deadline = e.deadline;
    if (e.finalCommit !== undefined) run.finalCommit = e.finalCommit;
    if (e.outcome !== undefined) run.outcome = e.outcome;
    run.startedAt ??= e.ts;
    if (TERMINAL_RUN_STATUSES.has(e.status)) run.endedAt = e.ts;
    return { ...s, run };
  },

  "agent.spawned": (s, e) => {
    const id = e.agentId;
    if (!id) return s;
    const agents = {
      ...s.agents,
      [id]: { ...s.agents[id]!, role: e.role, kind: e.kind, spawnedBy: e.spawnedBy, spawned: true },
    };
    return { ...s, agents, agentOrder: orderAgents(agents) };
  },

  "agent.state": (s, e) =>
    !e.agentId
      ? s
      : updateAgent(s, e.agentId, (a) => ({
          ...a,
          state: e.state,
          stateSince: a.state === e.state ? a.stateSince : e.ts,
          generation: e.generation,
          invocationId: e.invocationId,
          wakeAt: e.state === "waiting" ? e.wakeAt : undefined,
          detail: e.detail,
          stateHistory: [
            ...a.stateHistory,
            { seq: e.seq, ts: e.ts, state: e.state, generation: e.generation, detail: e.detail },
          ],
        })),

  "sandbox.state": (s, e) => {
    const id = e.agentId;
    const agent = id ? s.agents[id] : undefined;
    if (!id || !agent) return s;
    const old = agent.sandbox;
    const replaced = !!old && old.id !== e.sandboxId;
    const sandbox = replaced
      ? {
          id: e.sandboxId,
          state: e.state,
          previousIds: [...old.previousIds, old.id],
          replacedAt: e.ts,
        }
      : {
          id: e.sandboxId,
          state: e.state,
          previousIds: old?.previousIds ?? [],
          replacedAt: old?.replacedAt,
        };
    const next = updateAgent(s, id, (a) => ({ ...a, sandbox }));
    if (!replaced) return next;
    return {
      ...next,
      sandboxReplacements: [
        ...s.sandboxReplacements,
        {
          seq: e.seq,
          ts: e.ts,
          agentId: id,
          oldId: old.id,
          newId: e.sandboxId,
          generation: agent.generation,
        },
      ],
    };
  },

  "agent.woken": (s, e) =>
    !e.agentId
      ? s
      : updateAgent(s, e.agentId, (a) => {
          const wake = { reason: e.reason, seq: e.seq, ts: e.ts, causedBy: e.causedBy };
          return { ...a, lastWake: wake, wakes: [...a.wakes, wake] };
        }),

  checkpoint: (s, e) =>
    !e.agentId ? s : updateAgent(s, e.agentId, (a) => ({ ...a, checkpointVersion: e.version })),

  "message.sent": (s, e) => {
    const message: Message = {
      id: e.messageId,
      seq: e.seq,
      ts: e.ts,
      channelId: e.channelId,
      channelKind: e.channelKind,
      from: e.from,
      to: e.to,
      body: e.body,
      replyTo: e.replyTo,
      clientRequestId: e.clientRequestId,
    };
    const prevChannel = s.channels[e.channelId];
    const members =
      e.channelKind === "team"
        ? s.agentOrder
        : [...new Set([...(prevChannel?.members ?? []), e.from, ...e.to])];
    const channels = {
      ...s.channels,
      [e.channelId]: {
        id: e.channelId,
        kind: e.channelKind,
        members,
        lastSeq: e.seq,
        count: (prevChannel?.count ?? 0) + 1,
      },
    };
    let peerLinks = s.peerLinks;
    // Only DMs between agents grow the mesh. Team messages, @mentions and the operator's
    // DM with the orchestrator never create peer links.
    if (e.channelKind === "dm" && e.from !== USER_ID) {
      peerLinks = { ...peerLinks };
      for (const to of e.to) {
        if (to === e.from || to === USER_ID) continue;
        const key = peerKey(e.from, to);
        const link = peerLinks[key];
        const [a, b] = key.split("|") as [AgentId, AgentId];
        peerLinks[key] = link
          ? { ...link, count: link.count + 1, lastSeq: e.seq }
          : { key, a, b, count: 1, firstSeq: e.seq, lastSeq: e.seq };
      }
    }
    return { ...s, messages: [...s.messages, message], channels, peerLinks };
  },

  "delivery.queued": (s, e) => {
    const id = e.agentId;
    if (!id) return s;
    const next = updateAgent(s, id, (a) =>
      a.pendingDeliveries.includes(e.deliveryId)
        ? a
        : { ...a, pendingDeliveries: [...a.pendingDeliveries, e.deliveryId] },
    );
    return {
      ...next,
      deliveries: {
        ...s.deliveries,
        [e.deliveryId]: {
          id: e.deliveryId,
          messageId: e.messageId,
          agentId: id,
          seq: e.seq,
          done: false,
        },
      },
    };
  },

  "delivery.done": (s, e) => {
    const id = e.agentId;
    if (!id) return s;
    const next = updateAgent(s, id, (a) => ({
      ...a,
      pendingDeliveries: a.pendingDeliveries.filter((d) => d !== e.deliveryId),
    }));
    const prev = s.deliveries[e.deliveryId];
    return {
      ...next,
      deliveries: {
        ...s.deliveries,
        [e.deliveryId]: {
          id: e.deliveryId,
          messageId: e.messageId,
          agentId: id,
          seq: prev?.seq ?? e.seq,
          done: true,
        },
      },
    };
  },

  "task.upserted": (s, e) => {
    const prev = s.tasks[e.task.id];
    const changed =
      !prev ||
      prev.status !== e.task.status ||
      prev.ownerId !== e.task.ownerId ||
      prev.resultCommit !== e.task.resultCommit;
    const entry = {
      seq: e.seq,
      ts: e.ts,
      status: e.task.status,
      ownerId: e.task.ownerId,
      resultCommit: e.task.resultCommit,
      by: e.agentId,
    };
    const task: TaskView = {
      ...e.task,
      createdSeq: prev?.createdSeq ?? e.seq,
      createdBy: prev ? prev.createdBy : e.agentId,
      history: changed ? [...(prev?.history ?? []), entry] : prev.history,
    };
    const commits =
      task.resultCommit && !s.commits[task.resultCommit]
        ? {
            ...s.commits,
            [task.resultCommit]: {
              sha: task.resultCommit,
              seq: e.seq,
              pushed: false,
              verifications: [],
              message: `Submitted artifact: ${task.title}`,
            },
          }
        : s.commits;
    return { ...s, commits, tasks: { ...s.tasks, [task.id]: task } };
  },

  "tool.called": (s, e) =>
    !e.agentId
      ? s
      : updateAgent(s, e.agentId, (a) => ({
          ...a,
          lastTool: { tool: e.tool, summary: e.summary, ts: e.ts },
          tools: [...a.tools, { seq: e.seq, ts: e.ts, tool: e.tool, summary: e.summary }].slice(
            -TOOL_HISTORY,
          ),
        })),

  "git.pushed": (s, e) => {
    const prev = s.commits[e.commit];
    const commit: Commit = {
      sha: e.commit,
      branch: e.branch,
      agentId: e.agentId,
      ts: e.ts,
      message: e.message,
      seq: e.seq,
      pushed: true,
      verifications: prev?.verifications ?? [],
    };
    return { ...s, commits: { ...s.commits, [e.commit]: commit } };
  },

  "verification.recorded": (s, e) => {
    const prev: Commit = s.commits[e.commit] ?? {
      sha: e.commit,
      seq: e.seq,
      pushed: false,
      verifications: [],
    };
    const verification: Verification = {
      seq: e.seq,
      ts: e.ts,
      agentId: e.agentId,
      command: e.command,
      passed: e.passed,
      summary: e.summary,
    };
    return {
      ...s,
      commits: {
        ...s.commits,
        [e.commit]: { ...prev, verifications: [...prev.verifications, verification] },
      },
    };
  },

  usage: (s, e) =>
    !e.agentId
      ? s
      : updateAgent(s, e.agentId, (a) => ({
          ...a,
          usage: {
            inputTokens: a.usage.inputTokens + e.inputTokens,
            outputTokens: a.usage.outputTokens + e.outputTokens,
            costUsd: a.usage.costUsd + e.costUsd,
            costKnown: a.usage.costKnown !== false && e.costKnown !== false,
            durationMs: a.usage.durationMs + e.durationMs,
          },
        })),

  "worker.restarted": (s, e) => ({
    ...s,
    workerRestarts: [...s.workerRestarts, { seq: e.seq, ts: e.ts }],
  }),

  "failure.recorded": (s, e) => {
    const prev = s.failures[e.failureId];
    const failure: Failure = {
      id: e.failureId,
      seq: prev?.seq ?? e.seq,
      ts: prev?.ts ?? e.ts,
      agentId: e.agentId ?? prev?.agentId,
      scope: e.scope,
      message: e.message,
      resolved: e.resolved,
      updatedSeq: e.seq,
    };
    return { ...s, failures: { ...s.failures, [e.failureId]: failure } };
  },
};

export function fold(events: readonly DashboardEvent[], from: RunState = initialState()): RunState {
  let state = from;
  for (const event of events) state = reduce(state, event);
  return state;
}
