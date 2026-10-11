import type { ReactNode } from "react";
import { useRunState } from "../app/context";
import type { AgentId, AgentState, RunStatus } from "../contract/events";
import { AGENT_STATE_LABEL, sha } from "../state/format";
import { matchCommit, roleOf } from "../state/selectors";
import { actions } from "./uiStore";

const chip =
  "inline-flex items-center gap-1 rounded-box border px-1.5 font-mono text-chip leading-[20px] whitespace-nowrap align-baseline";

export function AgentChip({ id }: { id: AgentId }) {
  const state = useRunState();
  const known = !!state.agents[id];
  if (!known) return <span className={`${chip} border-line text-muted`}>{id}</span>;
  return (
    <button
      type="button"
      className={`${chip} border-line bg-card text-ink hover:bg-hub`}
      title={id}
      onClick={(e) => {
        e.stopPropagation();
        actions.selectAgent(id);
      }}
    >
      {roleOf(state, id)}
    </button>
  );
}

export function TaskChip({ id }: { id: string }) {
  const state = useRunState();
  if (!state.tasks[id]) return <span className={`${chip} border-line text-muted`}>{id}</span>;
  return (
    <button
      type="button"
      className={`${chip} border-line bg-card text-ink hover:bg-hub`}
      title={state.tasks[id].title}
      onClick={(e) => {
        e.stopPropagation();
        actions.selectTask(id);
      }}
    >
      {id}
    </button>
  );
}

export function CommitChip({ commit }: { commit: string }) {
  const state = useRunState();
  const full = state.commits[commit] ? commit : matchCommit(state, commit);
  if (!full) return <span className={`${chip} border-line text-muted`}>{sha(commit)}</span>;
  return (
    <button
      type="button"
      className={`${chip} border-ink bg-card text-ink hover:bg-hub`}
      title={full}
      onClick={(e) => {
        e.stopPropagation();
        actions.selectCommit(full);
      }}
    >
      {sha(full)}
    </button>
  );
}

export const AGENT_STATE_COLOR: Record<AgentState, string> = {
  provisioning: "var(--color-line)",
  waiting: "var(--color-ink)",
  running: "var(--color-accent)",
  checkpointing: "var(--color-accent)",
  recovering: "var(--color-amber)",
  needs_inspection: "var(--color-red)",
  failed: "var(--color-red)",
  stopped: "var(--color-line)",
};

export const RUN_STATUS_COLOR: Record<RunStatus, string> = {
  starting: "var(--color-amber)",
  running: "var(--color-accent)",
  completing: "var(--color-accent)",
  completed: "var(--color-ink)",
  failed: "var(--color-red)",
  cancelled: "var(--color-line)",
};

/** A 4px bar in the state color followed by the lowercase label. Never color alone. */
export function StateMarker({
  color,
  label,
  className = "",
}: {
  color: string;
  label: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        aria-hidden
        className="inline-block h-[1.1em] w-1 shrink-0"
        style={{ background: color }}
      />
      <span>{label}</span>
    </span>
  );
}

export function AgentStateMarker({ state, className }: { state: AgentState; className?: string }) {
  return (
    <StateMarker
      color={AGENT_STATE_COLOR[state]}
      label={AGENT_STATE_LABEL[state]}
      className={className}
    />
  );
}

/**
 * Message text with @mentions in accent and known commit SHAs and task IDs as chips.
 * Only IDs that exist in state are linked.
 */
export function RichText({ text }: { text: string }) {
  const state = useRunState();
  const taskIds = Object.keys(state.tasks);
  const parts: ReactNode[] = [];
  const re = /(@[\w-]+)|\b([0-9a-f]{7,40})\b|\b([A-Z]+\d+)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    const [token, mention, hex, task] = m;
    let node: ReactNode | undefined;
    if (mention)
      node = (
        <span key={k++} className="font-medium text-accent">
          {mention}
        </span>
      );
    else if (hex && matchCommit(state, hex)) node = <CommitChip key={k++} commit={hex} />;
    else if (task && taskIds.includes(task)) node = <TaskChip key={k++} id={task} />;
    if (!node) continue;
    parts.push(text.slice(last, m.index), node);
    last = m.index + token.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="atoi-label atoi-bullet mb-2 mt-5 font-mono text-title font-semibold text-ink first:mt-0">
      {children}
    </h3>
  );
}
