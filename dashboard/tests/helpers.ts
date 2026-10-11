import { FIXTURES } from "../fixtures/index";
import { type DashboardEvent, parseEvent } from "../src/contract/events";

/** Parse a fixture the way a source would, returning valid events and the skipped count. */
export function load(name: string): { events: DashboardEvent[]; skipped: number } {
  const build = FIXTURES[name];
  if (!build) throw new Error(`no fixture ${name}`);
  const events: DashboardEvent[] = [];
  let skipped = 0;
  for (const raw of build().events) {
    const r = parseEvent(JSON.parse(JSON.stringify(raw)));
    if (r.ok) events.push(r.event);
    else skipped++;
  }
  return { events, skipped };
}

let seq = 0;
/** Build a valid event with an auto-incrementing seq, for hand-written reducer tests. */
export function ev<T extends Record<string, unknown>>(payload: T, at?: number): DashboardEvent {
  seq = at ?? seq + 1;
  const r = parseEvent({
    seq,
    ts: new Date(Date.UTC(2026, 9, 11, 13, 50, seq)).toISOString(),
    runId: "r_test",
    ...payload,
  });
  if (!r.ok) throw new Error(r.error);
  return r.event;
}

export function resetSeq() {
  seq = 0;
}
