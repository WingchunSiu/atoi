import { z } from "zod";

const usage = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cost: z.object({ total: z.number().nonnegative() }),
});

/** Count newly recorded calls across the native tree, including compaction.
 * Old branches still cost money; restored entries must not be billed twice. */
export function invocationUsage(checkpoint: string, previous: string | null) {
  const entries = (text: string) =>
    text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const oldIds = new Set(previous ? entries(previous).map((entry) => entry.id) : []);
  const total = { input: 0, output: 0, cache: 0, cost: 0 };
  for (const entry of entries(checkpoint)) {
    if (oldIds.has(entry.id)) continue;
    const candidate =
      entry.type === "message" && entry.message?.role === "assistant"
        ? entry.message.usage
        : ["usage", "compaction", "branch_summary"].includes(entry.type)
          ? entry.usage
          : undefined;
    if (!candidate) continue;
    const value = usage.parse(candidate);
    total.input += value.input + value.cacheRead + value.cacheWrite;
    total.cache += value.cacheRead + value.cacheWrite;
    total.output += value.output;
    total.cost += value.cost.total;
  }
  return total;
}
