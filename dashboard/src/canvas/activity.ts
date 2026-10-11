// Turns newly arrived events into short-lived activity items (plan section 7.6).
// Items are declarative; the canvas components decide how to draw them.
import { type AgentId, type DashboardEvent, USER_ID } from "../contract/events";
import { clock } from "../state/format";
import type { RunState } from "../state/reduce";
import { peerKey } from "../state/reduce";

export type Route =
  | { kind: "peer"; from: AgentId; to: AgentId }
  | { kind: "user"; agentId: AgentId; toUser: boolean }
  | { kind: "spoke-in"; agentId: AgentId }
  | { kind: "spoke-out"; agentId: AgentId };

export type ActivityItem = { id: number; start: number; duration: number } & (
  | { kind: "dot"; route: Route }
  | {
      kind: "callout";
      text: string;
      anchor: { kind: "peer"; key: string } | { kind: "hub" } | { kind: "user"; agentId: AgentId };
    }
  | { kind: "pulse"; agentId: AgentId }
  | { kind: "card-highlight"; agentId: AgentId }
  | { kind: "wake-chip"; agentId: AgentId; text: string }
  | { kind: "spoke"; agentId: AgentId }
  | { kind: "hub-flash"; key: "tasks" | "commits" | "chat" }
  | { kind: "spawn"; from: AgentId; to: AgentId }
  | { kind: "fade-in"; agentId: AgentId }
  | { kind: "gen-flash"; agentId: AgentId }
  | { kind: "banner"; text: string }
  | { kind: "peer-reveal"; key: string }
  | { kind: "peer-highlight"; key: string }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewItem = DistributiveOmit<ActivityItem, "id" | "start" | "duration">;

export interface ActivitySnapshot {
  now: number;
  items: ActivityItem[];
}

const WAKE_GLYPH = { dm: "✉", mention: "@", timer: "⏱" } as const;

export class ActivityEngine {
  private snap: ActivitySnapshot = { now: 0, items: [] };
  private listeners = new Set<() => void>();
  private nextId = 1;
  private frame: number | undefined;
  /** When a message's dot reaches each recipient, keyed "messageId|agentId". */
  private arrivals = new Map<string, number>();

  constructor(
    private reducedMotion: () => boolean,
    private clockNow: () => number = () => performance.now(),
  ) {}

  get = (): ActivitySnapshot => this.snap;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  reset() {
    this.arrivals.clear();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.snap = { now: this.clockNow(), items: [] };
    this.emit();
  }

  private add(item: NewItem, start: number, duration: number) {
    this.snap.items.push({ ...item, id: this.nextId++, start, duration } as ActivityItem);
  }

  /** Called by the run store for newly arrived events. `after` is the state with them applied. */
  handle(applied: readonly DashboardEvent[], after: RunState) {
    const t = this.clockNow();
    const reduced = this.reducedMotion();
    const dotMs = 900;
    // Items are mutated in place below, so start from a fresh array.
    this.snap = { now: t, items: [...this.snap.items] };

    for (const e of applied) {
      switch (e.type) {
        case "message.sent": {
          const preview = e.body.replace(/\s+/g, " ").slice(0, 48);
          if (e.channelKind === "dm" && (e.from === USER_ID || e.to.includes(USER_ID))) {
            // The operator's DM with the orchestrator travels the "you" edge.
            const toUser = e.from !== USER_ID;
            const agent = toUser ? e.from : e.to[0];
            if (reduced)
              this.add({ kind: "peer-highlight", key: peerKey(e.from, e.to[0] ?? "") }, t, dotMs);
            else if (agent)
              this.add({ kind: "dot", route: { kind: "user", agentId: agent, toUser } }, t, dotMs);
            if (agent && !toUser)
              this.arrivals.set(`${e.messageId}|${agent}`, t + (reduced ? 0 : dotMs));
            if (agent)
              this.add(
                {
                  kind: "callout",
                  text: `${toUser ? "to you" : "you"} · ${preview}`,
                  anchor: { kind: "user", agentId: agent },
                },
                t,
                2500,
              );
          } else if (e.channelKind === "dm") {
            for (const to of e.to) {
              const key = peerKey(e.from, to);
              if (after.peerLinks[key]?.firstSeq === e.seq && !reduced)
                this.add({ kind: "peer-reveal", key }, t, 300);
              if (reduced) {
                this.add({ kind: "peer-highlight", key }, t, dotMs);
                this.arrivals.set(`${e.messageId}|${to}`, t);
              } else {
                this.add({ kind: "dot", route: { kind: "peer", from: e.from, to } }, t, dotMs);
                this.arrivals.set(`${e.messageId}|${to}`, t + dotMs);
              }
              this.add(
                { kind: "callout", text: `1 hop · ${preview}`, anchor: { kind: "peer", key } },
                t,
                2500,
              );
            }
          } else {
            const inbound = reduced ? 0 : dotMs;
            if (reduced) this.add({ kind: "spoke", agentId: e.from }, t, dotMs);
            else this.add({ kind: "dot", route: { kind: "spoke-in", agentId: e.from } }, t, dotMs);
            this.add({ kind: "hub-flash", key: "chat" }, t + inbound, 1200);
            for (const to of e.to) {
              if (reduced) this.add({ kind: "spoke", agentId: to }, t, dotMs);
              else
                this.add(
                  { kind: "dot", route: { kind: "spoke-out", agentId: to } },
                  t + inbound,
                  dotMs,
                );
              this.arrivals.set(`${e.messageId}|${to}`, t + 2 * inbound);
            }
            if (e.to.length)
              this.add(
                { kind: "callout", text: `team chat · ${preview}`, anchor: { kind: "hub" } },
                t + inbound,
                2500,
              );
          }
          break;
        }
        case "agent.woken": {
          if (!e.agentId) break;
          const arrival = e.causedBy ? this.arrivals.get(`${e.causedBy}|${e.agentId}`) : undefined;
          const start = Math.max(t, arrival ?? t);
          this.add(
            reduced
              ? { kind: "card-highlight", agentId: e.agentId }
              : { kind: "pulse", agentId: e.agentId },
            start,
            600,
          );
          this.add(
            {
              kind: "wake-chip",
              agentId: e.agentId,
              text: `${WAKE_GLYPH[e.reason]} woke · ${e.reason}`,
            },
            start,
            3000,
          );
          break;
        }
        case "task.upserted":
        case "git.pushed":
        case "verification.recorded": {
          if (e.agentId) this.add({ kind: "spoke", agentId: e.agentId }, t, 1200);
          this.add(
            { kind: "hub-flash", key: e.type === "task.upserted" ? "tasks" : "commits" },
            t,
            1200,
          );
          break;
        }
        case "agent.spawned": {
          if (!e.agentId) break;
          if (e.spawnedBy) this.add({ kind: "spawn", from: e.spawnedBy, to: e.agentId }, t, 2500);
          if (!reduced) this.add({ kind: "fade-in", agentId: e.agentId }, t, 300);
          break;
        }
        case "agent.state": {
          const history = e.agentId ? (after.agents[e.agentId]?.stateHistory ?? []) : [];
          const i = history.findIndex((h) => h.seq === e.seq);
          const was = i > 0 ? history[i - 1]!.generation : 0;
          if (e.agentId && e.generation > was && e.generation > 1)
            this.add({ kind: "gen-flash", agentId: e.agentId }, t, 3000);
          break;
        }
        case "worker.restarted":
          this.add(
            { kind: "banner", text: `Temporal worker restarted at ${clock(e.ts)}` },
            t,
            6000,
          );
          break;
      }
    }
    this.emit();
    this.loop();
  }

  private loop = () => {
    if (this.frame !== undefined) return;
    const tick = () => {
      const now = this.clockNow();
      const items = this.snap.items.filter((i) => now < i.start + i.duration);
      this.snap = { now, items };
      this.emit();
      if (items.length) this.frame = requestAnimationFrame(tick);
      else this.frame = undefined;
    };
    this.frame = requestAnimationFrame(tick);
  };

  dispose() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }
}

/** Items visible right now. */
export function activeItems(snap: ActivitySnapshot): ActivityItem[] {
  return snap.items.filter((i) => snap.now >= i.start && snap.now < i.start + i.duration);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
