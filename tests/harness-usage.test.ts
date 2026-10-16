import { expect, it } from "vitest";
import { invocationUsage } from "../src/harness/usage.js";

it("counts compaction, branch summaries and cache usage without charging restored history twice", () => {
  const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.25 } };
  const old = { id: "old", type: "message", message: { role: "assistant", usage } };
  const checkpoint = [
    old,
    { id: "new", type: "message", message: { role: "assistant", usage } },
    { id: "compact", type: "compaction", usage },
    { id: "branch", type: "branch_summary", usage },
    { id: "other", type: "usage", usage },
    { id: "user", type: "message", message: { role: "user", content: "hi" } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  expect(invocationUsage(checkpoint, JSON.stringify(old))).toEqual({
    input: 60,
    output: 20,
    cache: 20,
    cost: 1,
  });
});
