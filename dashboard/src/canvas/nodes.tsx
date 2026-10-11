import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { memo, useCallback } from "react";
import { useActivity, useNow, useRunSnapshot, useRunState, useUi } from "../app/context";
import type { AgentId } from "../contract/events";
import { userDmKey } from "../state/chat";
import { duration, roughDuration, truncate } from "../state/format";
import type { AgentView } from "../state/reduce";
import { AgentAvatar } from "../ui/AgentAvatar";
import { AGENT_STATE_COLOR, AgentStateMarker } from "../ui/chips";
import { actions } from "../ui/uiStore";
import { type ActivitySnapshot, activeItems } from "./activity";
import { CARD, HUB, USER_NODE } from "./geometry";

function Handles() {
  return (
    <>
      <Handle type="source" position={Position.Top} isConnectable={false} />
      <Handle type="target" position={Position.Bottom} isConnectable={false} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Agent card

export type AgentNodeType = Node<{ agentId: AgentId }, "agent">;

const BORDER: Record<AgentView["state"], { width: number; style: "solid" | "dashed" }> = {
  provisioning: { width: 1.5, style: "dashed" },
  waiting: { width: 1.5, style: "solid" },
  running: { width: 2.5, style: "solid" },
  checkpointing: { width: 2.5, style: "solid" },
  recovering: { width: 2.5, style: "solid" },
  needs_inspection: { width: 2.5, style: "solid" },
  failed: { width: 2.5, style: "dashed" },
  stopped: { width: 1.5, style: "solid" },
};

function cardFill(state: AgentView["state"]): string {
  if (state === "needs_inspection") return "var(--color-red-tint)";
  if (state === "provisioning" || state === "stopped") return "var(--color-paper)";
  return "var(--color-card)";
}

const SEP = "\u0001";

/** Activity items for one agent, as a stable string so cards only re-render when it changes. */
function useAgentActivity(agentId: AgentId) {
  const select = useCallback(
    (s: ActivitySnapshot) =>
      activeItems(s)
        .filter((i) => "agentId" in i && i.agentId === agentId)
        .map((i) => [i.kind, i.id, i.kind === "wake-chip" ? i.text : ""].join(SEP))
        .join("\n"),
    [agentId],
  );
  const key = useActivity(select);
  return key
    ? key.split("\n").map((line) => {
        const [kind, id, text] = line.split(SEP);
        return { kind: kind!, id: id!, text: text ?? "" };
      })
    : [];
}

function Countdown({ wakeAt }: { wakeAt: string }) {
  const now = useNow(250);
  return (
    <span title={`wakes at ${new Date(wakeAt).toLocaleTimeString()}`}>
      ⏱ {duration(Date.parse(wakeAt) - now)}
    </span>
  );
}

function IdleFor({ since }: { since: string }) {
  const now = useNow(1000);
  return <>idle {roughDuration(now - Date.parse(since))}</>;
}

function SandboxStrip({ sandbox }: { sandbox: NonNullable<AgentView["sandbox"]> }) {
  const now = useNow(500);
  const recent = sandbox.replacedAt && now - Date.parse(sandbox.replacedAt) < 10_000;
  const prevId = sandbox.previousIds.at(-1);
  const id = sandbox.state === "terminated" ? <s>{sandbox.id}</s> : sandbox.id;
  const tone =
    sandbox.state === "starting"
      ? "text-amber"
      : sandbox.state === "running"
        ? "text-ink"
        : "text-muted";
  // While "(was …)" is showing there's no room for the state word, so the dot carries it.
  const showWas = !!(recent && prevId);
  return (
    <div
      className={`flex h-[26px] items-center gap-2 border-t border-line/60 px-2 text-chip ${tone}`}
      title={`sandbox ${sandbox.id} ${sandbox.state}`}
    >
      <span className="truncate">
        sandbox {id}
        {showWas ? <span className="text-muted"> (was {prevId})</span> : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {sandbox.state === "running" && (
          <span aria-hidden className="inline-block size-2 rounded-full bg-ink" />
        )}
        {sandbox.state === "suspended" && (
          <span aria-hidden className="inline-block size-2 rounded-full border border-muted" />
        )}
        {!showWas && sandbox.state}
      </span>
    </div>
  );
}

function activityLine(agent: AgentView) {
  switch (agent.state) {
    case "running":
      return agent.lastTool ? `${agent.lastTool.tool}: ${agent.lastTool.summary}` : "";
    case "checkpointing":
      return agent.checkpointVersion !== undefined ? `checkpoint v${agent.checkpointVersion}` : "";
    case "recovering":
    case "needs_inspection":
    case "failed":
      return agent.detail ?? "";
    case "waiting":
      return agent.wakeAt ? (agent.detail ?? "") : null; // null → idle timer
    default:
      return agent.detail ?? "";
  }
}

export const AgentNode = memo(function AgentNode({ data }: NodeProps<AgentNodeType>) {
  const id = data.agentId;
  const agent = useRunSnapshot(useCallback((s) => s.state.agents[id], [id]));
  const selected = useUi(
    useCallback((u) => u.drawer?.kind === "agent" && u.drawer.id === id, [id]),
  );
  const items = useAgentActivity(id);
  if (!agent) return null;

  const border = BORDER[agent.state];
  const color = AGENT_STATE_COLOR[agent.state];
  const line = activityLine(agent);
  const pulse = items.find((i) => i.kind === "pulse");
  const highlight = items.some((i) => i.kind === "card-highlight");
  const fade = items.some((i) => i.kind === "fade-in");
  const genFlash = items.find((i) => i.kind === "gen-flash");
  const wakeChip = items.find((i) => i.kind === "wake-chip");

  return (
    <div className="relative" style={{ width: CARD.w, height: CARD.h }}>
      <Handles />
      {wakeChip && (
        <div className="absolute -top-8 right-0 z-10 rounded-box border border-accent bg-accent-tint px-2 text-chip leading-[22px] text-ink whitespace-nowrap">
          {wakeChip.text}
        </div>
      )}
      <button
        type="button"
        title={agent.id}
        aria-label={`${agent.role}, ${agent.state.replace("_", " ")}`}
        onClick={() => actions.selectAgent(id)}
        className={`flex h-full w-full flex-col rounded-box text-left text-ink ${fade ? "atoi-fade-in" : ""}`}
        style={{
          background: cardFill(agent.state),
          border: `${border.width}px ${border.style} ${color}`,
          opacity: agent.state === "stopped" ? 0.55 : 1,
          outline: selected
            ? "3px solid var(--color-ink)"
            : highlight
              ? "2.5px solid var(--color-accent)"
              : undefined,
          outlineOffset: 3,
        }}
      >
        <div className="flex w-full gap-2.5 px-2.5 pt-2">
          <AgentAvatar id={id} size={46} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-title font-semibold">{agent.role}</span>
              {agent.kind === "orchestrator" && agent.role !== "orchestrator" && (
                <span className="shrink-0 text-chip text-muted">orchestrator</span>
              )}
              {agent.generation > 1 && (
                <span
                  key={genFlash?.id}
                  className={`ml-auto shrink-0 rounded-box px-1 text-chip ${genFlash ? "atoi-gen-flash" : ""}`}
                >
                  gen {agent.generation}
                </span>
              )}
            </div>
            <AgentStateMarker state={agent.state} className="pt-0.5 text-body" />
          </div>
        </div>
        <div className="flex w-full min-w-0 items-center gap-3 px-2.5 pt-1 text-body">
          <span className="min-w-0 flex-1 truncate text-muted">
            {line === null ? <IdleFor since={agent.stateSince} /> : truncate(line, 60)}
          </span>
          {agent.pendingDeliveries.length > 0 && (
            <span className="shrink-0" title={`${agent.pendingDeliveries.length} pending in inbox`}>
              ✉ {agent.pendingDeliveries.length}
            </span>
          )}
          {agent.wakeAt && (
            <span className="shrink-0">
              <Countdown wakeAt={agent.wakeAt} />
            </span>
          )}
        </div>
        <div className="mt-auto w-full">
          {agent.sandbox && <SandboxStrip sandbox={agent.sandbox} />}
        </div>
      </button>
      {pulse && <div key={pulse.id} className="atoi-pulse" />}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Hub

export type HubNodeType = Node<Record<string, never>, "hub">;

const selectFlash = (s: ActivitySnapshot) =>
  activeItems(s)
    .flatMap((i) => (i.kind === "hub-flash" ? [i.key] : []))
    .sort()
    .join(",");

function HubCount({
  label,
  value,
  flash,
  onClick,
}: {
  label: string;
  value: string;
  flash: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-box border px-1.5 text-chip leading-[20px] ${flash ? "border-accent bg-accent text-card" : "border-ink/40 bg-transparent text-ink hover:bg-card"}`}
    >
      {label} {value}
    </button>
  );
}

export const HubNode = memo(function HubNode() {
  const state = useRunState();
  const flash = useActivity(selectFlash);
  const tasks = Object.values(state.tasks);
  const done = tasks.filter((t) => t.status === "done").length;
  const commits = Object.keys(state.commits).length;
  const teamCount = state.messages.filter((m) => m.channelKind === "team").length;
  return (
    <div
      className="atoi-hub flex flex-col items-center justify-center gap-0.5 border-2 border-ink bg-hub text-ink"
      style={{ width: HUB.w, height: HUB.h }}
    >
      <Handles />
      <div className="atoi-label text-title font-semibold">shared state</div>
      <div className="text-body">git · tasks · chat</div>
      <div className="mt-1.5 flex gap-1.5">
        <HubCount
          label="tasks"
          value={`${done}/${tasks.length}`}
          flash={flash.includes("tasks")}
          onClick={() => actions.openTab("tasks")}
        />
        <HubCount
          label="commits"
          value={String(commits)}
          flash={flash.includes("commits")}
          onClick={() => actions.openTab("git")}
        />
        <HubCount
          label="chat"
          value={String(teamCount)}
          flash={flash.includes("chat")}
          onClick={() => actions.openChat(null)}
        />
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Open slot

export type SlotNodeType = Node<Record<string, never>, "slot">;

export function SlotNode() {
  return (
    <div
      className="flex items-center justify-center rounded-box text-body text-muted"
      style={{
        width: CARD.w,
        height: CARD.h,
        border: "1.5px dashed var(--color-line)",
        opacity: 0.8,
      }}
    >
      <Handles />
      <span className="atoi-label">open slot</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The operator

export type UserNodeType = Node<Record<string, never>, "user">;

export const UserNode = memo(function UserNode() {
  const state = useRunState();
  const key = userDmKey(state);
  const selected = useUi(useCallback((u) => !!key && u.chat === key, [key]));
  return (
    <div className="relative" style={{ width: USER_NODE.w, height: USER_NODE.h }}>
      <Handles />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (key) actions.messageOrchestrator(key);
        }}
        aria-label="Message the orchestrator"
        className="flex h-full w-full flex-col justify-center rounded-box border-2 border-ink bg-card px-3 text-left text-ink hover:bg-hub"
        style={{ outline: selected ? "3px solid var(--color-ink)" : undefined, outlineOffset: 3 }}
      >
        <span className="text-title font-semibold">you</span>
        <span className="text-chip text-muted">operator</span>
      </button>
    </div>
  );
});
