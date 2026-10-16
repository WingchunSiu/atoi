import path from "node:path";
import { z } from "zod";
import { harnessId } from "./contracts.js";

const absolutePath = z.string().min(1).refine(path.isAbsolute, "Use an absolute path");

export const placementPlan = z
  .object({
    runId: harnessId,
    environments: z.array(z.object({ id: harnessId, stateRoot: absolutePath }).strict()).min(1),
    workspaces: z
      .array(
        z
          .object({
            id: harnessId,
            environmentId: harnessId,
            path: absolutePath,
            access: z.enum(["exclusive", "shared"]).default("exclusive"),
          })
          .strict(),
      )
      .min(1),
    agents: z.array(z.object({ id: harnessId, workspaceId: harnessId }).strict()).min(1),
  })
  .strict();

export type PlacementPlan = z.input<typeof placementPlan>;

export const agentPlacement = z.object({
  runId: harnessId,
  agentId: harnessId,
  environmentId: harnessId,
  workspaceId: harnessId,
  workspace: absolutePath,
  stateDirectory: absolutePath,
});
export type AgentPlacement = z.infer<typeof agentPlacement>;

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Resolve declared placements; provisioning and isolation belong to environment adapters. */
export function resolvePlacements(input: PlacementPlan): ReadonlyMap<string, AgentPlacement> {
  const plan = placementPlan.parse(input);
  function unique<T extends { id: string }>(items: T[], kind: string): Map<string, T> {
    const map = new Map<string, T>();
    for (const item of items) {
      if (map.has(item.id)) throw new Error(`Duplicate ${kind}: ${item.id}`);
      map.set(item.id, item);
    }
    return map;
  }
  const environments = unique(plan.environments, "environment");
  const workspaces = unique(plan.workspaces, "workspace");
  unique(plan.agents, "agent");
  const paths = new Set<string>();
  for (const workspace of workspaces.values()) {
    const environment = environments.get(workspace.environmentId);
    if (!environment) throw new Error(`Unknown environment: ${workspace.environmentId}`);
    const key = JSON.stringify([environment.id, path.resolve(workspace.path)]);
    if (paths.has(key)) throw new Error("Declare a shared workspace once, then assign its ID");
    paths.add(key);
    const stateRoot = path.resolve(environment.stateRoot);
    const workspacePath = path.resolve(workspace.path);
    if (contains(workspacePath, stateRoot) || contains(stateRoot, workspacePath))
      throw new Error("Keep session state outside task workspaces");
  }
  const occupants = new Set<string>();
  const placements = new Map<string, AgentPlacement>();
  for (const agent of plan.agents) {
    const workspace = workspaces.get(agent.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${agent.workspaceId}`);
    if (workspace.access === "exclusive" && occupants.has(workspace.id))
      throw new Error(`Workspace requires explicit shared access: ${workspace.id}`);
    occupants.add(workspace.id);
    const environment = environments.get(workspace.environmentId)!;
    placements.set(agent.id, {
      runId: plan.runId,
      agentId: agent.id,
      environmentId: environment.id,
      workspaceId: workspace.id,
      workspace: path.resolve(workspace.path),
      stateDirectory: path.join(environment.stateRoot, plan.runId, agent.id),
    });
  }
  return placements;
}
