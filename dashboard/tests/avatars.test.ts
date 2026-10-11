import { describe, expect, it } from "vitest";
import { assignAvatars } from "../src/ui/avatars";

describe("avatar assignment", () => {
  const ids = ["a_orch", "a_impl", "a_rev", "a_spec"];

  it("is stable for the same run and agent", () => {
    expect(assignAvatars(ids, "r_demo", 16)).toEqual(assignAvatars(ids, "r_demo", 16));
    // An agent joining later doesn't reshuffle the faces already handed out.
    expect(assignAvatars(ids.slice(0, 3), "r_demo", 16)).toEqual(
      Object.fromEntries(Object.entries(assignAvatars(ids, "r_demo", 16)).slice(0, 3)),
    );
  });

  it("gives every agent in a run a different face while the pool lasts", () => {
    const many = Array.from({ length: 16 }, (_, i) => `a_${i}`);
    expect(new Set(Object.values(assignAvatars(many, "r_x", 16))).size).toBe(16);
  });

  it("varies between runs", () => {
    const runs = ["r_1", "r_2", "r_3", "r_4"].map((r) => JSON.stringify(assignAvatars(ids, r, 16)));
    expect(new Set(runs).size).toBeGreaterThan(1);
  });

  it("reuses faces once the pool is exhausted", () => {
    const many = Array.from({ length: 20 }, (_, i) => `a_${i}`);
    const assigned = assignAvatars(many, "r_x", 16);
    expect(Object.keys(assigned)).toHaveLength(20);
    expect(Object.values(assigned).every((i) => i >= 0 && i < 16)).toBe(true);
  });
});
