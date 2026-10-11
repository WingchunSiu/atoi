import { describe, expect, it } from "vitest";
import { FIXTURES } from "../fixtures/index";
import { fold } from "../src/state/reduce";
import { RunStore } from "../src/state/runStore";
import { load } from "./helpers";

const tick = () => new Promise((r) => queueMicrotask(() => r(undefined)));

describe("run store", () => {
  for (const name of Object.keys(FIXTURES)) {
    it(`${name}: appending one event at a time equals folding the whole log`, () => {
      const { events } = load(name);
      const store = new RunStore();
      for (const e of events) store.append(e);
      expect(store.get().state).toEqual(fold(events));
    });
  }

  it("ignores duplicate deliveries and inserts out-of-order events", () => {
    const { events } = load("recovery");
    const store = new RunStore();
    for (const e of events) store.append(e);
    for (const e of events.slice(10, 20)) store.append(e);
    expect(store.get().events).toHaveLength(events.length);

    const shuffled = new RunStore();
    for (const e of [...events.slice(0, 30), ...events.slice(31), events[30]!]) shuffled.append(e);
    expect(shuffled.get().events.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
    expect(shuffled.get().state).toEqual(fold(events));
  });

  it("animates only events that arrive while they're recent, not the backlog", async () => {
    const { events } = load("happy-path");
    const last = Date.parse(events.at(-1)!.ts);
    const store = new RunStore("", () => last + 5000);
    const animated: number[] = [];
    store.onAdvance((fresh) => animated.push(...fresh.map((e) => e.seq)));
    for (const e of events) store.append(e);
    await tick();
    // Only events within 15 s of "now" count as fresh.
    expect(animated.length).toBeGreaterThan(0);
    expect(
      animated.every(
        (seq) => last + 5000 - Date.parse(events.find((e) => e.seq === seq)!.ts) < 15_000,
      ),
    ).toBe(true);
    expect(animated.length).toBeLessThan(events.length);
  });

  it("counts malformed events", async () => {
    const store = new RunStore();
    store.markSkipped();
    store.markSkipped();
    expect(store.get().skipped).toBe(2);
  });
});
