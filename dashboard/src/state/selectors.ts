import { type Point, slotCenter, slotCount } from "../canvas/geometry";
import type { AgentId, TaskStatus } from "../contract/events";
import { TERMINAL_RUN_STATUSES } from "../contract/events";
import { sha, TASK_STATUS_LABEL } from "./format";
import type { RunState, TaskView } from "./reduce";

export function roleOf(state: RunState, id: AgentId | undefined): string {
  if (!id) return "system";
  const agent = state.agents[id];
  return agent && agent.role !== "unknown" ? agent.role : id;
}

// ---------------------------------------------------------------------------
// Counters

const AWAKE = new Set(["running", "checkpointing", "recovering"]);

export interface Counters {
  awake: number;
  agents: number;
  messages: number;
  tasksDone: number;
  tasks: number;
  tokens: number;
  costUsd: number;
  elapsedMs?: number;
}

export function selectCounters(state: RunState, now: number): Counters {
  const agents = Object.values(state.agents);
  const tasks = Object.values(state.tasks);
  const startedAt = state.run?.startedAt ?? state.firstTs;
  const end = state.run?.endedAt ? Date.parse(state.run.endedAt) : now;
  return {
    awake: agents.filter((a) => AWAKE.has(a.state)).length,
    agents: agents.length,
    messages: state.messages.length,
    tasksDone: tasks.filter((t) => t.status === "done").length,
    tasks: tasks.length,
    tokens: agents.reduce((n, a) => n + a.usage.inputTokens + a.usage.outputTokens, 0),
    costUsd: agents.reduce((n, a) => n + a.usage.costUsd, 0),
    elapsedMs: startedAt ? Math.max(0, end - Date.parse(startedAt)) : undefined,
  };
}

export function isTerminal(state: RunState): boolean {
  return !!state.run && TERMINAL_RUN_STATUSES.has(state.run.status);
}

// ---------------------------------------------------------------------------
// Canvas

export interface Slot {
  index: number;
  center: Point;
  agentId?: AgentId;
}

export function selectSlots(state: RunState): { count: number; slots: Slot[] } {
  const count = slotCount(state.agentOrder.length, state.run?.workerLimit);
  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    slots.push({ index: i, center: slotCenter(i, count), agentId: state.agentOrder[i] });
  }
  return { count, slots };
}

export interface PeerEdge {
  key: string;
  a: AgentId;
  b: AgentId;
  count: number;
  width: number;
  firstSeq: number;
  lastSeq: number;
}

export function peerWidth(count: number): number {
  return 2 + Math.min(4, Math.log2(Math.max(1, count)));
}

export function selectPeerEdges(state: RunState): PeerEdge[] {
  return Object.values(state.peerLinks).map((l) => ({ ...l, width: peerWidth(l.count) }));
}

// ---------------------------------------------------------------------------
// Handoff

export interface HandoffEntry {
  seq: number;
  ts: string;
  kind: "task" | "push" | "verify";
  text: string;
  agentId?: AgentId;
  commit?: string;
  passed?: boolean;
  status?: TaskStatus;
}

export function describeTaskChange(
  state: RunState,
  prev: TaskView["history"][number] | undefined,
  cur: TaskView["history"][number],
): string {
  if (!prev) {
    const by = cur.by ? ` by ${roleOf(state, cur.by)}` : "";
    const owner = cur.ownerId ? `, owned by ${roleOf(state, cur.ownerId)}` : "";
    return `created${by}${cur.status === "open" ? "" : `, ${TASK_STATUS_LABEL[cur.status]}`}${owner}`;
  }
  if (cur.ownerId && cur.ownerId !== prev.ownerId && cur.status === "in_progress") {
    return `claimed by ${roleOf(state, cur.ownerId)}`;
  }
  if (!cur.ownerId && prev.ownerId) return `released by ${roleOf(state, prev.ownerId)}`;
  if (cur.status === prev.status && cur.resultCommit !== prev.resultCommit && cur.resultCommit) {
    return `result set to ${sha(cur.resultCommit)}`;
  }
  switch (cur.status) {
    case "in_review":
      return cur.resultCommit ? `in review at ${sha(cur.resultCommit)}` : "in review";
    case "done":
      return cur.by && cur.by !== cur.ownerId ? `done, marked by ${roleOf(state, cur.by)}` : "done";
    case "in_progress":
      return prev.status === "open" ? "in progress" : "back in progress";
    case "blocked":
      return "blocked";
    case "open":
      return "reopened";
  }
}

export function verificationText(
  state: RunState,
  commit: string,
  v: { agentId?: AgentId; command: string; passed: boolean; summary?: string },
): string {
  const who = v.agentId ? `${roleOf(state, v.agentId)} ran ` : "ran ";
  return `${who}${v.command} on ${sha(commit)}, ${v.passed ? "passed" : "failed"}${v.summary ? ` (${v.summary})` : ""}`;
}

export function selectHandoff(state: RunState): { task: TaskView; entries: HandoffEntry[] }[] {
  return Object.values(state.tasks)
    .sort((a, b) => a.createdSeq - b.createdSeq)
    .map((task) => {
      const entries: HandoffEntry[] = task.history.map((h, i) => ({
        seq: h.seq,
        ts: h.ts,
        kind: "task",
        text: describeTaskChange(state, task.history[i - 1], h),
        agentId: h.by,
        status: h.status,
        commit: h.resultCommit,
      }));
      const commits = new Set(
        task.history.map((h) => h.resultCommit).filter((c): c is string => !!c),
      );
      for (const c of commits) {
        const commit = state.commits[c];
        if (!commit) continue;
        if (commit.pushed && commit.ts) {
          entries.push({
            seq: commit.seq,
            ts: commit.ts,
            kind: "push",
            agentId: commit.agentId,
            commit: c,
            text: `${commit.agentId ? `${roleOf(state, commit.agentId)} ` : ""}pushed ${sha(c)}${commit.branch ? ` to ${commit.branch}` : ""}`,
          });
        }
        for (const v of commit.verifications) {
          entries.push({
            seq: v.seq,
            ts: v.ts,
            kind: "verify",
            agentId: v.agentId,
            commit: c,
            passed: v.passed,
            text: verificationText(state, c, v),
          });
        }
      }
      entries.sort((a, b) => a.seq - b.seq);
      return { task, entries };
    });
}

// ---------------------------------------------------------------------------
// Recovery, usage, result

export function selectRecovery(state: RunState) {
  return {
    restarts: state.workerRestarts,
    replacements: state.sandboxReplacements,
    failures: Object.values(state.failures).sort((a, b) => a.seq - b.seq),
  };
}

export function selectUsage(state: RunState) {
  const rows = state.agentOrder
    .map((id) => state.agents[id]!)
    .map((a) => ({
      agentId: a.id,
      role: a.role,
      tokens: a.usage.inputTokens + a.usage.outputTokens,
      costUsd: a.usage.costUsd,
      costKnown: a.usage.costKnown !== false,
      activeMs: a.usage.durationMs,
    }));
  const total = rows.reduce(
    (t, r) => ({
      tokens: t.tokens + r.tokens,
      costUsd: t.costUsd + r.costUsd,
      costKnown: t.costKnown && r.costKnown,
      activeMs: t.activeMs + r.activeMs,
    }),
    { tokens: 0, costUsd: 0, activeMs: 0, costKnown: true },
  );
  return { rows, total };
}

export function selectResult(state: RunState) {
  const finalCommit = state.run?.finalCommit;
  const commit = finalCommit ? state.commits[finalCommit] : undefined;
  return {
    finalCommit,
    outcome: state.run?.outcome,
    commit,
    latestVerification: commit?.verifications.at(-1),
  };
}

export function workersInUse(state: RunState): number {
  return Object.values(state.agents).filter(
    (a) => a.kind === "worker" && a.state !== "stopped" && a.state !== "failed",
  ).length;
}

/** Finds a known commit for a 7-40 char hex token (prefix match). */
export function matchCommit(state: RunState, token: string): string | undefined {
  if (!/^[0-9a-f]{7,40}$/.test(token)) return undefined;
  return Object.keys(state.commits).find((c) => c.startsWith(token) || token.startsWith(c));
}
