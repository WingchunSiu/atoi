import { useMemo } from "react";
import { useRunSnapshot } from "../app/context";
import type { AgentId } from "../contract/events";
import type { RunSnapshot } from "../state/runStore";
import { AVATAR_POOL, assignAvatars } from "./avatars";

const selectOrder = (s: RunSnapshot) => s.state.agentOrder;
const selectRunId = (s: RunSnapshot) => s.state.runId;

export function useAvatarUrl(id: AgentId): string | undefined {
  const order = useRunSnapshot(selectOrder);
  const runId = useRunSnapshot(selectRunId);
  const assigned = useMemo(() => assignAvatars(order, runId, AVATAR_POOL.length), [order, runId]);
  const i = assigned[id];
  return i === undefined ? undefined : AVATAR_POOL[i];
}

/** An agent's face. Decorative: the role name is always shown next to it. */
export function AgentAvatar({ id, size }: { id: AgentId; size: number }) {
  const url = useAvatarUrl(id);
  const style = { width: size, height: size };
  if (!url)
    return (
      <span
        aria-hidden
        className="atoi-avatar shrink-0 rounded-box border-[1.5px] border-ink bg-hub"
        style={style}
      />
    );
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      draggable={false}
      className="atoi-avatar shrink-0 select-none rounded-box border-[1.5px] border-ink bg-hub"
      style={style}
    />
  );
}
