import path from "node:path";
import { z } from "zod";
import { harnessId, invocationBudget } from "./contracts.js";
import { placementPlan, resolvePlacements } from "./placement.js";

export const swarmConfig = z
  .object({
    placement: placementPlan,
    controlRoot: z.string().refine(path.isAbsolute, "Use an absolute controlRoot"),
    objective: z.string().min(1).max(50_000),
    communication: z.enum(["messages", "files", "hybrid"]),
    agents: z
      .array(
        z
          .object({
            id: harnessId,
            provider: z.string().min(1),
            model: z.string().min(1),
            instructions: z.string().max(20_000).default(""),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    limits: z
      .object({
        concurrency: z.number().int().min(1).max(32),
        turns: z.number().int().min(1).max(1000),
        messages: z.number().int().min(1).max(1000),
        wallTimeMs: z.number().int().min(1000).max(86_400_000),
        invocation: invocationBudget,
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    try {
      const placements = resolvePlacements(config.placement);
      const ids = new Set(config.agents.map((agent) => agent.id));
      if (
        ids.size !== config.agents.length ||
        ids.size !== placements.size ||
        [...ids].some((id) => !placements.has(id))
      )
        throw new Error("Agent configuration must match placement identities exactly");
      // This executor runs in one environment. Cross-environment execution needs an adapter.
      if (config.placement.environments.length !== 1)
        throw new Error("The local swarm executor supports one environment per team");
      if (config.limits.messages < config.agents.length)
        throw new Error("Message budget must include the initial objective for each agent");
      const control = path.join(config.controlRoot, config.placement.runId);
      for (const placement of placements.values()) {
        for (const directory of [placement.workspace, placement.stateDirectory]) {
          const a = path.relative(directory, control);
          const b = path.relative(control, directory);
          const inside = (p: string) =>
            p === "" || (!p.startsWith(`..${path.sep}`) && p !== ".." && !path.isAbsolute(p));
          if (inside(a) || inside(b))
            throw new Error("Control state, Pi state and task workspaces must not overlap");
        }
      }
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message });
    }
  });
export type SwarmConfig = z.infer<typeof swarmConfig>;
