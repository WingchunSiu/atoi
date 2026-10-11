import { createContext, useContext, useEffect, useState } from "react";
import type { ActivityEngine, ActivitySnapshot } from "../canvas/activity";
import type { RunSummary } from "../sources/live";
import type { RunSource, SourceStatus } from "../sources/types";
import type { RunState } from "../state/reduce";
import type { RunSnapshot, RunStore } from "../state/runStore";
import { type Store, useStore } from "../state/store";
import { type UiState, ui } from "../ui/uiStore";

/** A message the operator sent that hasn't come back on the event stream yet. */
export interface Outgoing {
  clientRequestId: string;
  to: string;
  body: string;
  ts: string;
  status: "sending" | "failed";
  error?: string;
}

export interface RunContextValue {
  store: RunStore;
  activity: ActivityEngine;
  source: RunSource;
  status: Store<{ status: SourceStatus; since: number }>;
  outbox: Store<{ items: Outgoing[] }>;
  runs: RunSummary[];
}

export const RunContext = createContext<RunContextValue | null>(null);

export function useRun(): RunContextValue {
  const ctx = useContext(RunContext);
  if (!ctx) throw new Error("useRun outside RunContext");
  return ctx;
}

export function useRunSnapshot<S>(selector: (s: RunSnapshot) => S): S {
  return useStore(useRun().store, selector);
}

const selectState = (s: RunSnapshot) => s.state;
export function useRunState(): RunState {
  return useRunSnapshot(selectState);
}

export function useActivity<S>(selector: (s: ActivitySnapshot) => S): S {
  return useStore(useRun().activity, selector);
}

export function useUi<S>(selector: (s: UiState) => S): S {
  return useStore(ui, selector);
}

/** The wall clock, re-rendering every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}
