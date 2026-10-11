// Holds the run's ordered event log and the state folded over it. Sources append events;
// the dashboard always shows the newest state. There is no cursor and no replay.
import type { DashboardEvent } from "../contract/events";
import { fold, initialState, type RunState, reduce } from "./reduce";

/** Events older than this when they arrive are catch-up (backlog after connecting), not activity. */
export const FRESH_MS = 15_000;

export interface RunSnapshot {
  events: readonly DashboardEvent[];
  state: RunState;
  /** Events dropped because they failed validation. */
  skipped: number;
}

export type AdvanceListener = (fresh: readonly DashboardEvent[], state: RunState) => void;

export class RunStore {
  private snap: RunSnapshot;
  private listeners = new Set<() => void>();
  private advanceListeners = new Set<AdvanceListener>();
  private queued = false;
  private pending: DashboardEvent[] = [];

  constructor(
    runId = "",
    private now: () => number = () => Date.now(),
  ) {
    this.snap = { events: [], state: initialState(runId), skipped: 0 };
  }

  get = (): RunSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Fires for newly arrived, recent events, so the canvas can animate them. */
  onAdvance(listener: AdvanceListener): () => void {
    this.advanceListeners.add(listener);
    return () => this.advanceListeners.delete(listener);
  }

  append(event: DashboardEvent) {
    const { events, state } = this.snap;
    const last = events.at(-1);
    if (!last || event.seq > last.seq) {
      this.snap = { ...this.snap, events: [...events, event], state: reduce(state, event) };
      if (this.now() - Date.parse(event.ts) < FRESH_MS) this.pending.push(event);
    } else {
      // Duplicate delivery (for example after an SSE reconnect) or an out-of-order event.
      const at = binarySearch(events, event.seq);
      if (at.found) return;
      const next = [...events.slice(0, at.index), event, ...events.slice(at.index)];
      this.snap = { ...this.snap, events: next, state: fold(next, initialState(state.runId)) };
    }
    this.schedule();
  }

  // Authoritative snapshots update current state without creating activity animations.
  hydrate(state: RunState) {
    this.snap = { ...this.snap, state };
    this.schedule();
  }

  markSkipped() {
    this.snap = { ...this.snap, skipped: this.snap.skipped + 1 };
    this.schedule();
  }

  /** Sources can deliver hundreds of events at once; notify once per microtask. */
  private schedule() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      for (const l of this.listeners) l();
      if (!this.pending.length) return;
      const fresh = this.pending;
      this.pending = [];
      for (const l of this.advanceListeners) l(fresh, this.snap.state);
    });
  }
}

function binarySearch(
  events: readonly DashboardEvent[],
  seq: number,
): { found: boolean; index: number } {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const s = events[mid]!.seq;
    if (s === seq) return { found: true, index: mid };
    if (s < seq) lo = mid + 1;
    else hi = mid;
  }
  return { found: false, index: lo };
}
