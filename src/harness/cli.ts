import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readSwarmConfig, runSwarm } from "./swarm.js";
import { swarmConfig } from "./swarm-config.js";

export async function main(args: string[]) {
  const [command, location, objective, mode = "hybrid"] = args;
  if (command === "init" && location && objective) {
    const root = path.resolve(location);
    const shared = mode !== "messages";
    const config = swarmConfig.parse({
      placement: {
        runId: "experiment-1",
        environments: [{ id: "local", stateRoot: path.join(root, "sessions") }],
        workspaces: shared
          ? [
              {
                id: "common",
                environmentId: "local",
                path: path.join(root, "workspace"),
                access: "shared",
              },
            ]
          : ["alice", "bob"].map((id) => ({
              id,
              environmentId: "local",
              path: path.join(root, "workspaces", id),
            })),
        agents: ["alice", "bob"].map((id) => ({ id, workspaceId: shared ? "common" : id })),
      },
      controlRoot: path.join(root, "control"),
      objective,
      communication: mode,
      agents: ["alice", "bob"].map((id) => ({
        id,
        provider: process.env.PI_PROVIDER ?? "openai",
        model: process.env.PI_MODEL ?? "gpt-4.1",
        instructions:
          id === "alice"
            ? "Start the implementation. Ask bob for review when there is concrete evidence."
            : "Inspect the task and offer useful checks. Review concrete work when a peer asks.",
      })),
      limits: {
        concurrency: 2,
        turns: 12,
        messages: 24,
        wallTimeMs: 600_000,
        invocation: { timeoutMs: 120_000, modelRequests: 12, toolCalls: 30 },
      },
    });
    await mkdir(root, { recursive: true });
    const filename = path.join(root, "swarm.json");
    await writeFile(filename, JSON.stringify(config, null, 2), { flag: "wx" });
    console.log(filename);
    return;
  }
  if ((command === "run" || command === "inspect") && location) {
    const config = await readSwarmConfig(location);
    if (command === "inspect") {
      console.log(
        await readFile(path.join(config.controlRoot, config.placement.runId, "state.json"), "utf8"),
      );
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const state = await runSwarm(config, { signal: controller.signal });
      console.log(
        JSON.stringify(
          {
            status: state.status,
            turns: state.turns.length,
            messages: state.messages.length,
            results: state.turns.map(({ id, agentId, result, error }) => ({
              id,
              agentId,
              ...result,
              error: error ?? result?.error,
            })),
          },
          null,
          2,
        ),
      );
      if (state.status !== "quiescent") process.exitCode = 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  throw new Error(
    "Usage: swarm init <directory> <objective> [messages|files|hybrid] | swarm run <config.json> | swarm inspect <config.json>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
