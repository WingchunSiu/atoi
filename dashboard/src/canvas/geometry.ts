// Slot positions and edge paths. Shared by the edge components and the activity layer,
// so a moving message dot always follows exactly the drawn line.

export interface Point {
  x: number;
  y: number;
}

export const RING = { rx: 440, ry: 250 };
export const HUB = { w: 280, h: 110 };
export const CARD = { w: 240, h: 120 };
export const USER_NODE = { w: 150, h: 56 };
const USER_GAP = 70;

export function slotCount(agentCount: number, workerLimit?: number): number {
  if (workerLimit === undefined) return agentCount;
  return Math.max(1 + workerLimit, agentCount);
}

/** Center of slot `i` of `n`. Slot 0 is at the top, then clockwise. */
export function slotCenter(i: number, n: number): Point {
  const angle = (-90 + (i * 360) / Math.max(n, 1)) * (Math.PI / 180);
  const x = RING.rx * Math.cos(angle);
  const y = RING.ry * Math.sin(angle);
  // Avoid -0 so snapshots and tests stay stable.
  return { x: Math.abs(x) < 1e-9 ? 0 : x, y: Math.abs(y) < 1e-9 ? 0 : y };
}

/** Where the ray from a box's center toward `toward` leaves the box. */
export function boxEdgePoint(center: Point, size: { w: number; h: number }, toward: Point): Point {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const sx = dx === 0 ? Infinity : size.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : size.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: center.x + dx * s, y: center.y + dy * s };
}

export const HUB_CENTER: Point = { x: 0, y: 0 };

/** A spoke runs straight from the card's edge toward the hub's edge. */
export function spokeEnds(card: Point): { from: Point; to: Point } {
  return {
    from: boxEdgePoint(card, CARD, HUB_CENTER),
    to: boxEdgePoint(HUB_CENTER, HUB, card),
  };
}

/** The operator's node sits up and to the left of the orchestrator, top edges aligned. */
export function userCenter(orchestrator: Point): Point {
  return {
    x: orchestrator.x - CARD.w / 2 - USER_GAP - USER_NODE.w / 2,
    y: orchestrator.y - CARD.h / 2 + USER_NODE.h / 2,
  };
}

/** Straight edge between the operator and the orchestrator. */
export function userEdgeEnds(user: Point, orchestrator: Point): { from: Point; to: Point } {
  return {
    from: boxEdgePoint(user, USER_NODE, orchestrator),
    to: boxEdgePoint(orchestrator, CARD, user),
  };
}

export function linePath(from: Point, to: Point): string {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

export function pointOnLine(from: Point, to: Point, t: number): Point {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

export interface Curve {
  from: Point;
  control: Point;
  to: Point;
}

/**
 * A peer link is a quadratic curve whose control point is the segment midpoint pushed
 * away from the hub by a quarter of the segment length. For slots on opposite sides, that
 * push isn't enough, so it grows until the curve clears the hub.
 */
export function peerCurve(a: Point, b: Point): Curve {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const fromHub = Math.hypot(mid.x - HUB_CENTER.x, mid.y - HUB_CENTER.y);
  let dir: Point;
  if (fromHub > 1) {
    dir = { x: (mid.x - HUB_CENTER.x) / fromHub, y: (mid.y - HUB_CENTER.y) / fromHub };
  } else {
    // Midpoint sits on the hub: push perpendicular to the segment, preferring downward,
    // so both directions of the same pair draw the same curve.
    const nx = -(b.y - a.y) / (len || 1);
    const ny = (b.x - a.x) / (len || 1);
    dir = ny < 0 || (ny === 0 && nx < 0) ? { x: -nx, y: -ny } : { x: nx, y: ny };
  }
  const build = (push: number): Curve => {
    const control = { x: mid.x + dir.x * push, y: mid.y + dir.y * push };
    return { from: boxEdgePoint(a, CARD, control), control, to: boxEdgePoint(b, CARD, control) };
  };
  let push = 0.25 * len;
  let curve = build(push);
  for (let i = 0; i < 12 && crossesHub(curve); i++) {
    push = push * 1.25 + 20;
    curve = build(push);
  }
  return curve;
}

const HUB_MARGIN = 16;

function crossesHub(c: Curve): boolean {
  for (let k = 1; k < 20; k++) {
    const p = pointOnCurve(c, k / 20);
    if (Math.abs(p.x) < HUB.w / 2 + HUB_MARGIN && Math.abs(p.y) < HUB.h / 2 + HUB_MARGIN)
      return true;
  }
  return false;
}

export function curvePath(c: Curve): string {
  return `M ${c.from.x} ${c.from.y} Q ${c.control.x} ${c.control.y} ${c.to.x} ${c.to.y}`;
}

export function pointOnCurve(c: Curve, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * c.from.x + 2 * u * t * c.control.x + t * t * c.to.x,
    y: u * u * c.from.y + 2 * u * t * c.control.y + t * t * c.to.y,
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The area the mesh occupies for `n` slots: every card (with room for chips above), the hub,
 * and the given peer links.
 */
export function meshBounds(n: number, links: [Point, Point][] = [], withUser = false): Rect {
  const pts: Point[] = [
    { x: -HUB.w / 2, y: -HUB.h / 2 },
    { x: HUB.w / 2, y: HUB.h / 2 },
  ];
  if (withUser && n > 0) {
    const u = userCenter(slotCenter(0, n));
    pts.push(
      { x: u.x - USER_NODE.w / 2, y: u.y - USER_NODE.h / 2 - 36 },
      { x: u.x + USER_NODE.w / 2, y: u.y + USER_NODE.h / 2 },
    );
  }
  for (let i = 0; i < n; i++) {
    const c = slotCenter(i, n);
    pts.push(
      { x: c.x - CARD.w / 2, y: c.y - CARD.h / 2 - 36 },
      { x: c.x + CARD.w / 2, y: c.y + CARD.h / 2 },
    );
  }
  for (const [a, b] of links) {
    const curve = peerCurve(a, b);
    for (let k = 0; k <= 8; k++) pts.push(pointOnCurve(curve, k / 8));
    // Room for the "1 hop" callout, which sits just outside the curve's midpoint.
    const mid = pointOnCurve(curve, 0.5);
    const len = Math.hypot(mid.x, mid.y) || 1;
    pts.push({ x: mid.x + (mid.x / len) * 50, y: mid.y + (mid.y / len) * 50 });
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs) - 16;
  const y = Math.min(...ys) - 16;
  return { x, y, width: Math.max(...xs) + 16 - x, height: Math.max(...ys) + 16 - y };
}

/** Axis-aligned overlap test, used by layout tests. */
export function boxesOverlap(
  a: Point,
  aSize: { w: number; h: number },
  b: Point,
  bSize: { w: number; h: number },
): boolean {
  return Math.abs(a.x - b.x) * 2 < aSize.w + bSize.w && Math.abs(a.y - b.y) * 2 < aSize.h + bSize.h;
}
