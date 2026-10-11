// Human avatars for agents, from the generated pool in src/assets/avatars (npm run avatars).
// Each run deals the pool out at random but stably: the same agent keeps the same face
// everywhere, and no two agents in a run share one until the pool runs out.
import type { AgentId } from "../contract/events";

const files = import.meta.glob("../assets/avatars/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
export const AVATAR_POOL: string[] = Object.keys(files)
  .sort()
  .map((k) => files[k]!);

/** FNV-1a, so assignment is random-looking but deterministic. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pool index per agent, in join order. Collisions move to the next free entry. */
export function assignAvatars(
  agentIds: readonly AgentId[],
  salt: string,
  poolSize: number,
): Record<AgentId, number> {
  const out: Record<AgentId, number> = {};
  if (poolSize <= 0) return out;
  const taken = new Set<number>();
  for (const id of agentIds) {
    let i = hash(`${salt}:${id}`) % poolSize;
    if (taken.size < poolSize) while (taken.has(i)) i = (i + 1) % poolSize;
    taken.add(i);
    out[id] = i;
  }
  return out;
}
