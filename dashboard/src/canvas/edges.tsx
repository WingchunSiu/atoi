import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { memo, useCallback } from "react";
import { useActivity, useUi } from "../app/context";
import type { AgentId } from "../contract/events";
import { actions } from "../ui/uiStore";
import { type ActivitySnapshot, activeItems } from "./activity";
import { type Curve, curvePath, linePath, type Point, pointOnCurve, pointOnLine } from "./geometry";

export type SpokeEdgeType = Edge<{ agentId: AgentId; from: Point; to: Point }, "spoke">;
export type PeerEdgeType = Edge<
  { peerKey: string; curve: Curve; count: number; width: number; label: string },
  "peer"
>;
export type UserEdgeType = Edge<{ peerKey: string; from: Point; to: Point; count: number }, "user">;

/** Dotted line from an agent to shared state. Turns accent briefly when the agent writes to it. */
export const SpokeEdge = memo(function SpokeEdge({ id, data }: EdgeProps<SpokeEdgeType>) {
  const agentId = data!.agentId;
  const lit = useActivity(
    useCallback(
      (s: ActivitySnapshot) =>
        activeItems(s).some((i) => i.kind === "spoke" && i.agentId === agentId),
      [agentId],
    ),
  );
  return (
    <BaseEdge
      id={id}
      path={linePath(data!.from, data!.to)}
      style={
        lit
          ? { stroke: "var(--color-accent)", strokeWidth: 2.5 }
          : {
              stroke: "var(--color-line)",
              strokeWidth: 1.5,
              strokeDasharray: "2 6",
              strokeLinecap: "round",
            }
      }
    />
  );
});

function useEdgeFlags(peerKey: string) {
  const flags = useActivity(
    useCallback(
      (s: ActivitySnapshot) => {
        const items = activeItems(s);
        const reveal = items.find((i) => i.kind === "peer-reveal" && i.key === peerKey);
        const lit = items.some((i) => i.kind === "peer-highlight" && i.key === peerKey);
        return `${reveal ? reveal.id : ""}|${lit ? 1 : 0}`;
      },
      [peerKey],
    ),
  );
  const selected = useUi(useCallback((u) => u.chat === peerKey, [peerKey]));
  const [revealId, lit] = flags.split("|");
  return { revealId, lit: lit === "1", selected };
}

/** A DM edge: a wide transparent hit area, a halo when selected, the stroke and a count chip. */
function DmEdge({
  id,
  path,
  mid,
  width,
  peerKey,
  count,
  title,
}: {
  id: string;
  path: string;
  mid: Point;
  width: number;
  peerKey: string;
  count: number;
  title: string;
}) {
  const { revealId, lit, selected } = useEdgeFlags(peerKey);
  return (
    <>
      {selected && (
        <path
          d={path}
          fill="none"
          stroke="var(--color-accent-tint)"
          strokeWidth={width + 12}
          strokeLinecap="round"
        />
      )}
      <path
        key={revealId || "static"}
        d={path}
        fill="none"
        pathLength={revealId ? 1 : undefined}
        className={`react-flow__edge-path ${revealId ? "atoi-draw" : ""}`}
        style={{
          stroke: lit ? "var(--color-accent)" : "var(--color-ink)",
          strokeWidth: selected ? width + 1 : width,
        }}
      />
      <path
        id={id}
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(20, width + 14)}
        className="react-flow__edge-interaction"
        style={{ cursor: "pointer", pointerEvents: "stroke" }}
        onClick={(e) => {
          e.stopPropagation();
          actions.toggleChat(peerKey);
        }}
      />
      {count > 0 && (
        <EdgeLabelRenderer>
          <button
            type="button"
            title={title}
            aria-pressed={selected}
            // Don't let the click reach the pane, which would switch back to #team.
            onClick={(e) => {
              e.stopPropagation();
              actions.toggleChat(peerKey);
            }}
            className={`nodrag nopan absolute rounded-box border font-mono text-chip leading-[20px] px-1.5 ${
              selected ? "border-ink bg-ink text-card" : "border-ink bg-card text-ink hover:bg-hub"
            }`}
            style={{
              transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
              pointerEvents: "all",
            }}
          >
            {count}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Solid curve between two agents that have DMed. Width grows with the number of DMs. */
export const PeerEdge = memo(function PeerEdge({ id, data }: EdgeProps<PeerEdgeType>) {
  const { peerKey, curve, count, width, label } = data!;
  return (
    <DmEdge
      id={id}
      path={curvePath(curve)}
      mid={pointOnCurve(curve, 0.5)}
      width={width}
      peerKey={peerKey}
      count={count}
      title={`${label}: ${count} DM${count === 1 ? "" : "s"}. Show this conversation.`}
    />
  );
});

/** The operator's line to the orchestrator. Always present, so the DM is always reachable. */
export const UserEdge = memo(function UserEdge({ id, data }: EdgeProps<UserEdgeType>) {
  const { peerKey, from, to, count } = data!;
  return (
    <DmEdge
      id={id}
      path={linePath(from, to)}
      mid={pointOnLine(from, to, 0.5)}
      width={2}
      peerKey={peerKey}
      count={count}
      title={`you ↔ orchestrator: ${count} message${count === 1 ? "" : "s"}. Show this conversation.`}
    />
  );
});
