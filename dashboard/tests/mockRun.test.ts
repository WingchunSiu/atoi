import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURES } from "../fixtures/index";
import { parseEvent, USER_ID } from "../src/contract/events";
import { MockRun, type RawEvent } from "../src/sources/mockRun";
import { fold } from "../src/state/reduce";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T20:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function started(name: string, speed = 1) {
  const run = new MockRun(FIXTURES[name]!().events as RawEvent[], speed);
  run.start();
  return run;
}

const parsed = (run: MockRun) =>
  run.events.flatMap((e) => {
    const r = parseEvent(e);
    return r.ok ? [r.event] : [];
  });

describe("mock run", () => {
  it("assigns seq and ts as events are written, like a backend", () => {
    const run = started("happy-path");
    vi.advanceTimersByTime(5_000);
    const seqs = run.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(Date.parse(run.events.at(-1)!.ts)).toBeGreaterThanOrEqual(
      Date.parse("2026-10-11T20:00:00Z"),
    );
    run.stop();
  });

  it("plays the whole fixture with compressed gaps", () => {
    const run = started("happy-path", 8);
    vi.advanceTimersByTime(60_000);
    expect(run.runStatus).toBe("completed");
    run.stop();
  });

  it("accepts the operator's DM, wakes the orchestrator and replies, once per request id", () => {
    const run = started("recovery");
    vi.advanceTimersByTime(10_000);
    const req = { to: "a_orch", body: "Please also cover CRLF.", clientRequestId: "req-1" };
    const first = run.send(req);
    expect(first.ok).toBe(true);
    expect(run.send(req)).toEqual(first);
    vi.advanceTimersByTime(3_000);
    const state = fold(parsed(run));
    const dm = state.messages.filter((m) => m.from === USER_ID || m.to.includes(USER_ID));
    expect(dm).toHaveLength(2);
    expect(dm[0]).toMatchObject({ from: USER_ID, clientRequestId: "req-1", to: ["a_orch"] });
    expect(dm[1]!.body).toContain("[mock reply]");
    expect(state.agents.a_orch!.pendingDeliveries).toEqual([]);
    expect(state.agents.a_orch!.wakes.at(-1)?.reason).toBe("dm");
    run.stop();
  });

  it("refuses messages before the orchestrator exists and after the run ends", () => {
    const early = new MockRun(FIXTURES["happy-path"]!().events as RawEvent[]);
    expect(early.send({ to: "a_orch", body: "hi", clientRequestId: "r" })).toMatchObject({
      ok: false,
      status: 404,
    });
    const done = started("happy-path", 8);
    vi.advanceTimersByTime(60_000);
    expect(done.send({ to: "a_orch", body: "hi", clientRequestId: "r2" })).toMatchObject({
      ok: false,
      status: 409,
    });
    done.stop();
  });
});
