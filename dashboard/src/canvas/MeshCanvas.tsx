import {
  Background,
  BackgroundVariant,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActivity, useReducedMotion, useRun, useRunState } from "../app/context";
import { type AgentId, USER_ID } from "../contract/events";
import { dmLabel, dmMessages, userDmKey } from "../state/chat";
import { selectPeerEdges, selectSlots } from "../state/selectors";
import { actions } from "../ui/uiStore";
import { ActivityLayer, LayoutContext } from "./ActivityLayer";
import { type ActivitySnapshot, activeItems } from "./activity";
import { PeerEdge, SpokeEdge, UserEdge } from "./edges";
import {
  CARD,
  HUB,
  meshBounds,
  type Point,
  peerCurve,
  spokeEnds,
  USER_NODE,
  userCenter,
  userEdgeEnds,
} from "./geometry";
import { AgentNode, HubNode, SlotNode, UserNode } from "./nodes";
import { ScenicBackdrop } from "./ScenicBackdrop";

const nodeTypes: NodeTypes = { agent: AgentNode, hub: HubNode, slot: SlotNode, user: UserNode };
const edgeTypes: EdgeTypes = { spoke: SpokeEdge, peer: PeerEdge, user: UserEdge };

const GLIDE_MS = 400;
const FIXED = { draggable: false, selectable: false, focusable: false } as const;

/** Tween slot positions over 400 ms when the slot count changes. */
function useGlide(targets: Record<string, Point>, reduced: boolean): Record<string, Point> {
  const key = JSON.stringify(targets);
  const [pos, setPos] = useState(targets);
  const current = useRef(targets);
  useEffect(() => {
    const from = current.current;
    const moving = Object.entries(targets).some(
      ([k, p]) => from[k] && (from[k].x !== p.x || from[k].y !== p.y),
    );
    if (!moving || reduced) {
      current.current = targets;
      setPos(targets);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / GLIDE_MS);
      const e = 1 - Math.pow(1 - p, 3);
      const next: Record<string, Point> = {};
      for (const [k, to] of Object.entries(targets)) {
        const f = from[k] ?? to;
        next[k] = { x: f.x + (to.x - f.x) * e, y: f.y + (to.y - f.y) * e };
      }
      current.current = next;
      setPos(next);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reduced]);
  const merged: Record<string, Point> = {};
  for (const [k, p] of Object.entries(targets)) merged[k] = pos[k] ?? p;
  return merged;
}

const selectBanner = (s: ActivitySnapshot) => {
  const b = activeItems(s).find((i) => i.kind === "banner");
  return b && b.kind === "banner" ? b.text : "";
};

function Mesh({ waitingText, inset }: { waitingText?: string; inset: number }) {
  const state = useRunState();
  const reduced = useReducedMotion();
  const { setViewport } = useReactFlow();
  const container = useRef<HTMLDivElement>(null);
  const banner = useActivity(selectBanner);

  const { count, slots } = useMemo(
    () => selectSlots(state),
    [state.agentOrder, state.run?.workerLimit],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const userKey = userDmKey(state);
  const orchestrator = userKey?.split("|").find((id) => id !== USER_ID);

  const targets = useMemo(() => {
    const t: Record<string, Point> = {};
    for (const s of slots) t[s.agentId ? `agent:${s.agentId}` : `slot:${s.index}`] = s.center;
    return t;
  }, [slots]);
  const positions = useGlide(targets, reduced);

  const layout = useMemo(() => {
    const l: Record<AgentId, Point> = {};
    for (const [k, p] of Object.entries(positions)) if (k.startsWith("agent:")) l[k.slice(6)] = p;
    if (orchestrator && l[orchestrator]) l[USER_ID] = userCenter(l[orchestrator]);
    return l;
  }, [positions, orchestrator]);

  const nodes: Node[] = useMemo(() => {
    const agentNodes: Node[] = [];
    const slotNodes: Node[] = [];
    for (const s of slots) {
      const id = s.agentId ? `agent:${s.agentId}` : `slot:${s.index}`;
      const c = positions[id] ?? s.center;
      const node = {
        id,
        position: { x: c.x - CARD.w / 2, y: c.y - CARD.h / 2 },
        width: CARD.w,
        height: CARD.h,
        ...FIXED,
      };
      if (s.agentId) agentNodes.push({ ...node, type: "agent", data: { agentId: s.agentId } });
      else slotNodes.push({ ...node, type: "slot", data: {} });
    }
    const hub: Node = {
      id: "hub",
      type: "hub",
      position: { x: -HUB.w / 2, y: -HUB.h / 2 },
      width: HUB.w,
      height: HUB.h,
      data: {},
      ...FIXED,
    };
    const user = layout[USER_ID];
    const userNode: Node[] = user
      ? [
          {
            id: "user",
            type: "user",
            position: { x: user.x - USER_NODE.w / 2, y: user.y - USER_NODE.h / 2 },
            width: USER_NODE.w,
            height: USER_NODE.h,
            data: {},
            ...FIXED,
          },
        ]
      : [];
    // The operator and agents first so Tab moves through them in order.
    return [...userNode, ...agentNodes, hub, ...slotNodes];
  }, [slots, positions, layout]);

  const peers = useMemo(() => selectPeerEdges(state), [state.peerLinks]); // eslint-disable-line react-hooks/exhaustive-deps
  const userCount = userKey ? dmMessages(state, userKey).length : 0;
  const edges: Edge[] = useMemo(() => {
    const spokes: Edge[] = state.agentOrder.flatMap((id) => {
      const p = layout[id];
      if (!p) return [];
      const ends = spokeEnds(p);
      return [
        {
          id: `spoke:${id}`,
          source: `agent:${id}`,
          target: "hub",
          type: "spoke",
          ...FIXED,
          data: { agentId: id, from: ends.from, to: ends.to },
        },
      ];
    });
    const links: Edge[] = peers.flatMap((l) => {
      const a = layout[l.a];
      const b = layout[l.b];
      if (!a || !b) return [];
      return [
        {
          id: `peer:${l.key}`,
          source: `agent:${l.a}`,
          target: `agent:${l.b}`,
          type: "peer",
          ...FIXED,
          data: {
            peerKey: l.key,
            curve: peerCurve(a, b),
            count: l.count,
            width: l.width,
            label: dmLabel(state, l.key),
          },
        },
      ];
    });
    const user = layout[USER_ID];
    const orch = orchestrator ? layout[orchestrator] : undefined;
    const userEdge: Edge[] =
      user && orch && userKey
        ? [
            {
              id: "user-edge",
              source: "user",
              target: `agent:${orchestrator}`,
              type: "user",
              ...FIXED,
              data: { peerKey: userKey, count: userCount, ...userEdgeEnds(user, orch) },
            },
          ]
        : [];
    return [...spokes, ...links, ...userEdge];
  }, [state, layout, peers, orchestrator, userKey, userCount]);

  // Fit the slots, the operator and the peer links that exist into the part of the canvas the
  // details drawer doesn't cover. Uses slot targets, not glide positions, so it's stable.
  const linkKey = peers
    .map((l) => l.key)
    .sort()
    .join(",");
  const linkEnds = useMemo(() => {
    const at: Record<AgentId, Point> = {};
    for (const s of slots) if (s.agentId) at[s.agentId] = s.center;
    return peers.flatMap((l) => (at[l.a] && at[l.b] ? [[at[l.a], at[l.b]] as [Point, Point]] : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, linkKey]);
  const fit = useCallback(
    (animate: boolean) => {
      const el = container.current;
      if (!el) return;
      const W = el.clientWidth - inset;
      const H = el.clientHeight;
      if (W <= 0 || H <= 0) return;
      const b = meshBounds(Math.max(count, 1), linkEnds, !!orchestrator);
      const zoom = Math.min(2, Math.max(0.3, Math.min(W / b.width, H / b.height) * 0.96));
      const x = inset + (W - b.width * zoom) / 2 - b.x * zoom;
      const y = (H - b.height * zoom) / 2 - b.y * zoom;
      void setViewport({ x, y, zoom }, { duration: animate && !reduced ? 300 : 0 });
    },
    [setViewport, count, linkEnds, orchestrator, inset, reduced],
  );
  const fitted = useRef(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      fit(fitted.current);
      fitted.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, [fit]);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fit(false));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fit]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type === "agent") actions.selectAgent((node.data as { agentId: AgentId }).agentId);
  }, []);

  return (
    <div ref={container} className="relative h-full w-full">
      <ScenicBackdrop />
      <LayoutContext.Provider value={layout}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomActivationKeyCode={null}
          disableKeyboardA11y
          // A click handler also tells React Flow to keep pointer events on for nodes, which
          // it otherwise disables for nodes that are neither selectable nor draggable.
          onNodeClick={onNodeClick}
          onPaneClick={() => actions.openChat(null)}
          minZoom={0.3}
          maxZoom={2}
        >
          {/* A faint grid; transparent unless the theme sets --color-grid. */}
          <Background
            variant={BackgroundVariant.Lines}
            gap={48}
            lineWidth={1}
            color="var(--color-grid, transparent)"
          />
          <ActivityLayer />
        </ReactFlow>
      </LayoutContext.Provider>
      {banner && (
        <div
          role="status"
          className="absolute right-6 top-3 z-10 border-l-4 border-amber bg-amber-tint px-3 py-1.5 text-title text-ink"
          style={{ left: inset + 24 }}
        >
          {banner}
        </div>
      )}
      {waitingText && (
        <div
          className="pointer-events-none absolute inset-x-0 top-1/2 mt-20 text-center text-title text-muted"
          style={{ paddingLeft: inset }}
        >
          {waitingText}
        </div>
      )}
    </div>
  );
}

export function MeshCanvas({ inset = 0 }: { inset?: number }) {
  const { source, store } = useRun();
  const [isEmpty, setEmpty] = useState(() => store.get().events.length === 0);
  useEffect(() => store.subscribe(() => setEmpty(store.get().events.length === 0)), [store]);
  const waitingText = isEmpty
    ? source.kind === "live"
      ? `Connecting to run ${source.runId}…`
      : "Starting the mock run…"
    : undefined;
  return (
    <ReactFlowProvider>
      <Mesh waitingText={waitingText} inset={inset} />
    </ReactFlowProvider>
  );
}
