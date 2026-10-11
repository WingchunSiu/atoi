// Moving message dots, callout chips and spawn connectors, drawn in flow coordinates on top of
// the mesh. Paths come from geometry.ts so dots follow exactly the drawn lines.
import { ViewportPortal } from "@xyflow/react";
import { createContext, useContext } from "react";
import { useActivity } from "../app/context";
import { type AgentId, USER_ID } from "../contract/events";
import { type ActivityItem, type ActivitySnapshot, activeItems, type Route } from "./activity";
import {
  boxEdgePoint,
  CARD,
  HUB,
  type Point,
  peerCurve,
  pointOnCurve,
  pointOnLine,
  spokeEnds,
  userEdgeEnds,
} from "./geometry";

/** Current centers of agent cards, plus the operator's node under USER_ID. */
export const LayoutContext = createContext<Record<AgentId, Point>>({});

const ease = (t: number) => 1 - Math.pow(1 - t, 2);

function dotPoint(route: Route, layout: Record<AgentId, Point>, t: number): Point | undefined {
  if (route.kind === "user") {
    const user = layout[USER_ID];
    const agent = layout[route.agentId];
    if (!user || !agent) return undefined;
    const { from, to } = userEdgeEnds(user, agent);
    return route.toUser ? pointOnLine(to, from, t) : pointOnLine(from, to, t);
  }
  if (route.kind === "peer") {
    const a = layout[route.from];
    const b = layout[route.to];
    if (!a || !b) return undefined;
    return pointOnCurve(peerCurve(a, b), t);
  }
  const card = layout[route.agentId];
  if (!card) return undefined;
  const { from, to } = spokeEnds(card);
  return route.kind === "spoke-in" ? pointOnLine(from, to, t) : pointOnLine(to, from, t);
}

function calloutPoint(
  item: Extract<ActivityItem, { kind: "callout" }>,
  layout: Record<AgentId, Point>,
): Point | undefined {
  if (item.anchor.kind === "hub") return { x: 0, y: HUB.h / 2 + 30 };
  if (item.anchor.kind === "user") {
    const user = layout[USER_ID];
    return user ? { x: user.x, y: user.y - 52 } : undefined;
  }
  const [a, b] = item.anchor.key.split("|");
  const pa = layout[a!];
  const pb = layout[b!];
  if (!pa || !pb) return undefined;
  const curve = peerCurve(pa, pb);
  const mid = pointOnCurve(curve, 0.5);
  // Nudge the chip off the line, away from the hub, so it doesn't cover the count chip.
  const len = Math.hypot(mid.x, mid.y) || 1;
  return { x: mid.x + (mid.x / len) * 34, y: mid.y + (mid.y / len) * 34 };
}

const selectSnap = (s: ActivitySnapshot) => s;

export function ActivityLayer() {
  const snap = useActivity(selectSnap);
  const layout = useContext(LayoutContext);
  const items = activeItems(snap);
  if (!items.length) return null;

  const dots: { id: number; p: Point }[] = [];
  const spawns: { id: number; from: Point; to: Point }[] = [];
  const callouts: { id: number; p: Point; text: string }[] = [];

  for (const item of items) {
    if (item.kind === "dot") {
      const t = ease(Math.min(1, (snap.now - item.start) / item.duration));
      const p = dotPoint(item.route, layout, t);
      if (p) dots.push({ id: item.id, p });
    } else if (item.kind === "spawn") {
      const a = layout[item.from];
      const b = layout[item.to];
      if (a && b)
        spawns.push({ id: item.id, from: boxEdgePoint(a, CARD, b), to: boxEdgePoint(b, CARD, a) });
    } else if (item.kind === "callout") {
      const p = calloutPoint(item, layout);
      if (p) callouts.push({ id: item.id, p, text: item.text });
    }
  }

  return (
    <ViewportPortal>
      <svg
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        width="1"
        height="1"
        aria-hidden
      >
        {spawns.map((s) => (
          <line
            key={s.id}
            x1={s.from.x}
            y1={s.from.y}
            x2={s.to.x}
            y2={s.to.y}
            stroke="var(--color-accent)"
            strokeWidth={2}
            strokeDasharray="8 6"
          />
        ))}
        {dots.map((d) => (
          <circle key={d.id} cx={d.p.x} cy={d.p.y} r={4} fill="var(--color-accent)" />
        ))}
      </svg>
      {callouts.map((c) => (
        <div
          key={c.id}
          className="pointer-events-none absolute left-0 top-0 max-w-[340px] truncate rounded-box border border-accent bg-accent-tint px-2 font-mono text-chip leading-[22px] text-ink"
          style={{ transform: `translate(${c.p.x}px, ${c.p.y}px) translate(-50%, -50%)` }}
        >
          {c.text}
        </div>
      ))}
    </ViewportPortal>
  );
}
