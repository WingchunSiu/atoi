import { fetchRuns, LiveSource, type RunSummary } from "./live";
import { MockSource } from "./mock";
import type { RunSource, SourceKind } from "./types";

export const FIXTURE_NAMES = ["happy-path", "recovery", "third-worker", "edge-states"];

export type Resolved =
  | { kind: "ready"; source: RunSource; runs: RunSummary[] }
  | { kind: "no-runs" }
  | { kind: "error"; message: string };

export function sourceKindFromUrl(search: string): SourceKind {
  const p = new URLSearchParams(search).get("source");
  const k = p ?? import.meta.env.VITE_DEFAULT_SOURCE ?? "mock";
  return k === "live" ? "live" : "mock";
}

/**
 * The URL selects the source:
 *   ?source=mock&fixture=recovery&speed=2   a scripted fixture, streamed like a live run
 *   ?source=live&run=r_8f2                  a backend run (without run, the newest one)
 */
export async function resolveSource(search: string, signal?: AbortSignal): Promise<Resolved> {
  const params = new URLSearchParams(search);
  if (sourceKindFromUrl(search) === "mock") {
    const name = params.get("fixture") ?? "happy-path";
    const speed = Math.min(8, Math.max(0.25, Number(params.get("speed")) || 1));
    const runs = FIXTURE_NAMES.map((id) => ({ id, objective: id, mock: true }));
    return { kind: "ready", runs, source: new MockSource(name, speed) };
  }

  let runs: RunSummary[];
  try {
    runs = await fetchRuns(signal);
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const wanted = params.get("run");
  if (!wanted && runs.length === 0) return { kind: "no-runs" };
  const run = wanted ? runs.find((r) => r.id === wanted) : runs[0];
  return { kind: "ready", runs, source: new LiveSource(wanted ?? run!.id, !!run?.mock) };
}

export function urlFor(kind: SourceKind, id: string): string {
  const p = new URLSearchParams();
  p.set("source", kind);
  p.set(kind === "mock" ? "fixture" : "run", id);
  return `?${p.toString()}`;
}
