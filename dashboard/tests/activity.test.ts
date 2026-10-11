import { beforeAll, describe, expect, it } from "vitest";
import { ActivityEngine } from "../src/canvas/activity";
import { USER_ID } from "../src/contract/events";
import { fold } from "../src/state/reduce";
import { load } from "./helpers";

beforeAll(() => {
  // The engine's frame loop needs these in Node.
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame ??= ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
});

const { events } = load("happy-path");
const isAgentDm = (e: (typeof events)[number]) =>
  e.type === "message.sent" &&
  e.channelKind === "dm" &&
  e.from !== USER_ID &&
  !e.to.includes(USER_ID);
const firstDm = events.findIndex(isAgentDm);

function run(reduced: boolean, from: number, count: number) {
  let now = 1000;
  const engine = new ActivityEngine(
    () => reduced,
    () => now,
  );
  for (let i = from; i < from + count; i++) {
    engine.handle([events[i]!], fold(events.slice(0, i + 1)));
    now += 10;
  }
  return engine;
}

describe("activity engine", () => {
  it("animates the first DM with a dot, a 1-hop callout and a peer-link reveal", () => {
    const kinds = run(false, firstDm, 1)
      .get()
      .items.map((i) => i.kind)
      .sort();
    expect(kinds).toEqual(["callout", "dot", "peer-reveal"]);
  });

  it("does not reveal a peer link again on later DMs", () => {
    const secondDm = events.findIndex((e, i) => i > firstDm && isAgentDm(e));
    const kinds = run(false, secondDm, 1)
      .get()
      .items.map((i) => i.kind);
    expect(kinds).not.toContain("peer-reveal");
    expect(kinds).toContain("dot");
  });

  it("starts the wake pulse when the DM's dot arrives", () => {
    const wake = events.findIndex((e, i) => i > firstDm && e.type === "agent.woken");
    const engine = run(false, firstDm, wake - firstDm + 1);
    const dot = engine.get().items.find((i) => i.kind === "dot")!;
    const pulse = engine.get().items.find((i) => i.kind === "pulse")!;
    expect(pulse.start).toBe(dot.start + dot.duration);
  });

  it("uses static highlights instead of motion under prefers-reduced-motion", () => {
    const wake = events.findIndex((e, i) => i > firstDm && e.type === "agent.woken");
    const kinds = new Set(
      run(true, firstDm, wake - firstDm + 1)
        .get()
        .items.map((i) => i.kind),
    );
    expect(kinds.has("dot")).toBe(false);
    expect(kinds.has("pulse")).toBe(false);
    expect(kinds.has("peer-reveal")).toBe(false);
    expect(kinds.has("peer-highlight")).toBe(true);
    expect(kinds.has("card-highlight")).toBe(true);
    expect(kinds.has("wake-chip")).toBe(true);
  });

  it("sends the operator's DM along the 'you' edge", () => {
    const userDm = events.findIndex((e) => e.type === "message.sent" && e.from === USER_ID);
    const items = run(false, userDm, 1).get().items;
    expect(items.find((i) => i.kind === "dot")).toMatchObject({
      route: { kind: "user", agentId: "a_orch", toUser: false },
    });
    expect(items.map((i) => i.kind)).not.toContain("peer-reveal");
  });

  it("clears everything on reset", () => {
    const engine = run(false, firstDm, 3);
    engine.reset();
    expect(engine.get().items).toEqual([]);
  });
});
