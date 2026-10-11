// What the chat panel shows. #team is the high-level view: messages plus run milestones.
// A DM is the detailed view: the pair's messages interleaved with both agents' activity.
import { type AgentId, type DashboardEvent, USER_ID } from "../contract/events";
import { AGENT_STATE_LABEL, clock, sha, truncate } from "./format";
import { type Message, peerKey, type RunState } from "./reduce";
import { describeTaskChange, roleOf } from "./selectors";

export type Tone = "default" | "muted" | "red" | "amber" | "green" | "accent";

export type ChatItem =
  | { kind: "message"; key: string; seq: number; ts: string; message: Message }
  | { kind: "milestone"; key: string; seq: number; ts: string; text: string; tone: Tone }
  | {
      kind: "activity";
      key: string;
      seq: number;
      ts: string;
      agentId: AgentId;
      icon: string;
      text: string;
      tone: Tone;
    };

export const TEAM = "team";

/** Name for any chat participant, including the operator. */
export function nameOf(state: RunState, id: AgentId): string {
  return id === USER_ID ? "you" : roleOf(state, id);
}

export function dmLabel(state: RunState, key: string): string {
  const [a, b] = key.split("|") as [AgentId, AgentId];
  // Put the operator first so it reads "you ↔ orchestrator".
  const [x, y] = b === USER_ID ? [b, a] : [a, b];
  return `${nameOf(state, x)} ↔ ${nameOf(state, y)}`;
}

/** The DM key for the operator and the orchestrator, once the orchestrator exists. */
export function userDmKey(state: RunState): string | undefined {
  const orch = state.agentOrder.find((id) => state.agents[id]?.kind === "orchestrator");
  return orch ? peerKey(orch, USER_ID) : undefined;
}

/** Only operator/agent conversations have an operator composer. */
export function operatorDmRecipient(state: RunState, key: string | null): AgentId | undefined {
  const pair = key?.split("|") ?? [];
  if (pair.length !== 2 || !pair.includes(USER_ID)) return undefined;
  const id = pair.find((id) => id !== USER_ID);
  return id && state.agents[id] ? id : undefined;
}

export function orchestratorId(state: RunState): AgentId | undefined {
  return state.agentOrder.find((id) => state.agents[id]?.kind === "orchestrator");
}

function asItems(messages: Message[]): ChatItem[] {
  return messages.map((m) => ({
    kind: "message",
    key: `m:${m.id}`,
    seq: m.seq,
    ts: m.ts,
    message: m,
  }));
}

/** DMs between exactly this pair, matched by participants rather than channel id. */
export function dmMessages(state: RunState, key: string): Message[] {
  return state.messages.filter(
    (m) => m.channelKind === "dm" && peerKey(m.from, m.to[0] ?? "") === key && m.to.length === 1,
  );
}

function taskChangeText(
  state: RunState,
  e: Extract<DashboardEvent, { type: "task.upserted" }>,
): string | undefined {
  const history = state.tasks[e.task.id]?.history ?? [];
  const i = history.findIndex((h) => h.seq === e.seq);
  if (i < 0) return undefined; // nothing that matters changed
  return `${truncate(e.task.id, 13)} ${describeTaskChange(state, history[i - 1], history[i]!)}`;
}

/** #team: every team message, plus milestones a person watching the run cares about. */
export function teamItems(events: readonly DashboardEvent[], state: RunState): ChatItem[] {
  const items: ChatItem[] = asItems(state.messages.filter((m) => m.channelKind === "team"));
  const replacements = new Map(state.sandboxReplacements.map((r) => [r.seq, r]));
  for (const e of events) {
    const base = { key: `e:${e.seq}`, seq: e.seq, ts: e.ts };
    let text: string | undefined;
    let tone: Tone = "muted";
    switch (e.type) {
      case "run.state":
        if (e.status === "starting") text = `Run started${e.objective ? `: ${e.objective}` : ""}`;
        else if (e.status === "available")
          text = "Objective completed. Team available for follow-ups.";
        else if (e.status === "completed")
          text = `Run completed${state.run?.finalCommit ? ` at ${sha(state.run.finalCommit)}` : ""}`;
        else if (e.status === "failed" || e.status === "cancelled") {
          text = `Run ${e.status}`;
          tone = "red";
        } else if (e.status === "completing")
          text = `${e.outcome ?? "Orchestrator is finishing the run"}`;
        break;
      case "agent.spawned":
        text = `${e.role} joined${e.spawnedBy ? `, spawned by ${roleOf(state, e.spawnedBy)}` : ""}`;
        break;
      case "task.upserted":
        text = taskChangeText(state, e);
        if (e.task.status === "done") tone = "green";
        break;
      case "worker.restarted":
        text = "Temporal worker restarted. Pending work carries on.";
        tone = "amber";
        break;
      case "sandbox.state": {
        const r = replacements.get(e.seq);
        if (r) {
          text = `${roleOf(state, r.agentId)} moved to a new sandbox (${r.oldId} → ${r.newId}), gen ${r.generation}`;
          tone = "amber";
        }
        break;
      }
      case "failure.recorded":
        text = `[${e.scope}] ${e.message}${e.resolved ? " (resolved)" : ""}`;
        tone = e.resolved ? "muted" : "red";
        break;
    }
    if (text) items.push({ kind: "milestone", ...base, text, tone });
  }
  return items.sort((a, b) => a.seq - b.seq);
}

const WAKE_ICON = { dm: "✉", mention: "@", timer: "⏱" } as const;

/** One agent's activity line for a DM view, or undefined for events too noisy to show. */
function activity(
  state: RunState,
  e: DashboardEvent,
): { icon: string; text: string; tone: Tone } | undefined {
  const messages = state.messages;
  switch (e.type) {
    case "agent.woken": {
      const cause = e.causedBy ? messages.find((m) => m.id === e.causedBy) : undefined;
      const from = cause ? ` from ${nameOf(state, cause.from)}` : "";
      return {
        icon: WAKE_ICON[e.reason],
        text: `woke on ${e.reason === "timer" ? "a timer" : `a ${e.reason}${from}`}`,
        tone: "accent",
      };
    }
    case "tool.called":
      return { icon: "›", text: `${e.tool}: ${e.summary}`, tone: "default" };
    case "git.pushed":
      return {
        icon: "↑",
        text: `pushed ${sha(e.commit)} to ${e.branch}${e.message ? `: ${e.message}` : ""}`,
        tone: "default",
      };
    case "verification.recorded":
      return {
        icon: e.passed ? "✓" : "✗",
        text: `${e.command} on ${sha(e.commit)} ${e.passed ? "passed" : "failed"}${e.summary ? ` (${e.summary})` : ""}`,
        tone: e.passed ? "green" : "red",
      };
    case "checkpoint":
      return {
        icon: "◆",
        text: `${e.action === "saved" ? "saved" : "restored"} checkpoint v${e.version}`,
        tone: "muted",
      };
    case "agent.state":
      if (e.state === "waiting") {
        return {
          icon: "☾",
          text: e.wakeAt
            ? `sleeping until ${clock(e.wakeAt)}${e.detail ? `: ${e.detail}` : ""}`
            : "sleeping",
          tone: "muted",
        };
      }
      if (
        e.state === "recovering" ||
        e.state === "needs_inspection" ||
        e.state === "failed" ||
        e.state === "stopped"
      ) {
        return {
          icon: "▍",
          text: `${AGENT_STATE_LABEL[e.state]}${e.generation > 1 ? `, gen ${e.generation}` : ""}${e.detail ? `: ${e.detail}` : ""}`,
          tone: e.state === "recovering" ? "amber" : e.state === "stopped" ? "muted" : "red",
        };
      }
      return undefined;
    case "sandbox.state":
      return {
        icon: "▢",
        text: `sandbox ${e.sandboxId} ${e.state}`,
        tone: e.state === "starting" ? "amber" : "muted",
      };
    case "task.upserted": {
      const text = taskChangeText(state, e);
      return text
        ? { icon: "☐", text, tone: e.task.status === "done" ? "green" : "default" }
        : undefined;
    }
    case "failure.recorded":
      return {
        icon: "!",
        text: `[${e.scope}] ${e.message}${e.resolved ? " (resolved)" : ""}`,
        tone: e.resolved ? "muted" : "red",
      };
    case "unknown":
      return { icon: "?", text: `unrecognized event "${e.originalType}"`, tone: "amber" };
    default:
      return undefined; // deliveries, usage, run state and messages are shown elsewhere
  }
}

/** A DM: the pair's messages, plus (optionally) both agents' activity interleaved. */
export function dmItems(
  events: readonly DashboardEvent[],
  state: RunState,
  key: string,
  withActivity: boolean,
): ChatItem[] {
  const items: ChatItem[] = asItems(dmMessages(state, key));
  if (withActivity) {
    const pair = new Set(key.split("|").filter((id) => id !== USER_ID));
    for (const e of events) {
      if (!e.agentId || !pair.has(e.agentId) || e.type === "message.sent") continue;
      const a = activity(state, e);
      if (a)
        items.push({
          kind: "activity",
          key: `e:${e.seq}`,
          seq: e.seq,
          ts: e.ts,
          agentId: e.agentId,
          ...a,
        });
    }
  }
  return items.sort((a, b) => a.seq - b.seq);
}

/** Unknown event types, which only show inside DMs of the agent they name. */
export function unknownCount(events: readonly DashboardEvent[]): number {
  return events.filter((e) => e.type === "unknown").length;
}
