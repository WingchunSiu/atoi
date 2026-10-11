import { describe, expect, it } from "vitest";
import {
  boxesOverlap,
  CARD,
  HUB,
  peerCurve,
  pointOnCurve,
  slotCenter,
  slotCount,
  USER_NODE,
  userCenter,
} from "../src/canvas/geometry";

describe("geometry", () => {
  it("puts slot 0 at the top", () => {
    expect(slotCenter(0, 3)).toEqual({ x: 0, y: -250 });
  });

  it("sizes slots from the worker limit and grows past it", () => {
    expect(slotCount(3, 2)).toBe(3);
    expect(slotCount(1, 2)).toBe(3);
    expect(slotCount(5, 2)).toBe(5);
    expect(slotCount(4)).toBe(4);
  });

  for (let n = 2; n <= 8; n++) {
    it(`lays out ${n} slots without overlapping each other or the hub`, () => {
      const centers = Array.from({ length: n }, (_, i) => slotCenter(i, n));
      for (let i = 0; i < n; i++) {
        expect(boxesOverlap(centers[i]!, CARD, { x: 0, y: 0 }, HUB)).toBe(false);
        for (let j = i + 1; j < n; j++)
          expect(boxesOverlap(centers[i]!, CARD, centers[j]!, CARD)).toBe(false);
      }
    });
  }

  for (let n = 1; n <= 8; n++) {
    it(`keeps the operator node clear of ${n} slots`, () => {
      const centers = Array.from({ length: n }, (_, i) => slotCenter(i, n));
      const user = userCenter(centers[0]!);
      expect(boxesOverlap(user, USER_NODE, { x: 0, y: 0 }, HUB)).toBe(false);
      for (const c of centers) expect(boxesOverlap(user, USER_NODE, c, CARD)).toBe(false);
    });
  }

  it("never routes a peer link through the hub, including between opposite slots", () => {
    for (let n = 2; n <= 8; n++) {
      const centers = Array.from({ length: n }, (_, i) => slotCenter(i, n));
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const curve = peerCurve(centers[i]!, centers[j]!);
          for (let k = 0; k <= 40; k++) {
            const p = pointOnCurve(curve, k / 40);
            const inHub = Math.abs(p.x) < HUB.w / 2 && Math.abs(p.y) < HUB.h / 2;
            expect(inHub, `n=${n} ${i}-${j} t=${k / 40}`).toBe(false);
          }
        }
      }
    }
  });

  it("draws the same curve in both directions", () => {
    const a = slotCenter(1, 4);
    const b = slotCenter(3, 4);
    expect(peerCurve(a, b).control).toEqual(peerCurve(b, a).control);
  });
});
