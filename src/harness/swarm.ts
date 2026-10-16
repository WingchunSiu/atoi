import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { harnessId, type PiInvocation, type PiResult, piResult } from "./contracts.js";
import { atomicJson, loadJson, lockController } from "./file-store.js";
import { executePiTurn, type PiRuntimeOptions, redact, sha256 } from "./pi-runtime.js";
import { resolvePlacements } from "./placement.js";
import { type SwarmConfig, swarmConfig } from "./swarm-config.js";

const messageSchema = z.object({
  id: harnessId,
  from: harnessId,
  to: harnessId,
  body: z.string().max(50_000),
  cause: z.string(),
  acknowledgedBy: harnessId.optional(),
});
const turnSchema = z.object({
  id: harnessId,
  agentId: harnessId,
  deliveries: z.array(harnessId),
  prompt: z.string(),
  previous: harnessId.nullable(),
  status: z.enum(["prepared", "confirmed", "interrupted"]),
  result: z
    .object({
      outcome: piResult.shape.outcome,
      text: z.string(),
      usage: piResult.shape.usage,
      error: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
});
export const swarmState = z.object({
  version: z.literal(1),
  fingerprint: z.string(),
  started: z.number(),
  status: z.enum(["running", "quiescent", "limited", "failed", "cancelled"]),
  messages: z.array(messageSchema).max(1000),
  turns: z.array(turnSchema).max(1000),
});
export type SwarmState = z.infer<typeof swarmState>;
type Turn = SwarmState["turns"][number];
export interface SwarmOptions {
  signal?: AbortSignal;
  // Deployment boundary: a remote executor must preserve invocation identity,
  // cancellation, tool routing and checkpoints. The default executes locally.
  execute?: (request: PiInvocation, options: PiRuntimeOptions) => Promise<PiResult>;
  configureSession?: PiRuntimeOptions["configureSession"];
}

/** Bounded, event-driven peer scheduling. Quiescence is not task verification. */
export async function runSwarm(
  input: SwarmConfig,
  options: SwarmOptions = {},
): Promise<SwarmState> {
  const config = swarmConfig.parse(input);
  const placements = resolvePlacements(config.placement);
  const root = path.join(config.controlRoot, config.placement.runId);
  const release = await lockController(root);
  const filename = path.join(root, "state.json");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timer: NodeJS.Timeout | undefined;
  // Pi tools can call concurrently; every state transaction is serialized.
  let writes: Promise<unknown> = Promise.resolve();
  function transaction<T>(operation: () => Promise<T>): Promise<T> {
    const next = writes.then(operation);
    writes = next.catch(() => {});
    return next;
  }
  const active = new Map<string, Promise<void>>();
  let state: SwarmState;
  try {
    const fingerprint = sha256(JSON.stringify(config));
    const stored = await loadJson(filename);
    state =
      stored === undefined
        ? {
            version: 1,
            fingerprint,
            started: Date.now(),
            status: "running",
            messages: config.agents.map((agent, index) => ({
              id: `message-${index + 1}`,
              from: "operator",
              to: agent.id,
              body: config.objective,
              cause: "objective",
            })),
            turns: [],
          }
        : swarmState.parse(stored);
    if (state.fingerprint !== fingerprint)
      throw new Error("Run ID already has different configuration; use a new run ID");
    if (["quiescent", "limited", "cancelled"].includes(state.status)) return state;
    if (
      state.status === "failed" &&
      state.turns.some((turn) => turn.result && turn.result.outcome !== "completed")
    )
      return state;
    state.status = "running";
    await atomicJson(filename, state);
    const remaining = config.limits.wallTimeMs - (Date.now() - state.started);
    timer = setTimeout(abort, Math.max(0, remaining));
    if (remaining <= 0) abort();
    await Promise.all(
      [...placements.values()].map((placement) => mkdir(placement.workspace, { recursive: true })),
    );
    const persist = () => atomicJson(filename, state);
    const secretValues = [process.env.ATOI_MODEL_API_KEY, process.env.GITHUB_TOKEN];

    function launch(turn: Turn) {
      const work = (async () => {
        try {
          const agent = config.agents.find((agent) => agent.id === turn.agentId)!;
          const placement = placements.get(agent.id)!;
          const previous = turn.previous
            ? piResult.parse(await loadJson(path.join(root, "results", `${turn.previous}.json`)))
            : null;
          const request: PiInvocation = {
            agentId: agent.id,
            runId: config.placement.runId,
            invocationId: turn.id,
            generation: 1,
            provider: agent.provider,
            model: agent.model,
            prompt: turn.prompt,
            checkpoint: previous?.checkpoint ?? null,
            budget: config.limits.invocation,
          };
          const result = piResult.parse(
            await (options.execute ?? executePiTurn)(request, {
              placement,
              signal: controller.signal,
              configureSession: options.configureSession,
              profile: {
                id: `filesystem-peers-v1-${config.communication}`,
                systemPrompt: `You are ${agent.id}. Peers: ${config.agents.map((peer) => peer.id).join(", ")}.\n${agent.instructions}\nA turn ending does not finish the team task. Addressed messages wake peers. Avoid acknowledgement loops; only send useful work or evidence. Communication mode: ${config.communication}. Workspaces are ${config.placement.workspaces.map((workspace) => `${workspace.id}=${workspace.path}`).join(", ")}. These directory assignments are not security isolation.`,
                bind: () => ({
                  tools:
                    config.communication === "files"
                      ? []
                      : [
                          defineTool({
                            name: "send_message",
                            label: "Send peer message",
                            description:
                              "Durably send a message to a peer; this schedules a follow-up turn. Sender and causal invocation are assigned by the harness.",
                            parameters: Type.Object({
                              to: Type.String(),
                              body: Type.String({ minLength: 1, maxLength: 50_000 }),
                            }),
                            execute: async (callId, args) => {
                              const accepted = await transaction(async () => {
                                if (!placements.has(args.to))
                                  throw new Error(`Unknown peer: ${args.to}`);
                                if (controller.signal.aborted) throw new Error("Run stopping");
                                const cause = `${turn.id}:${callId}`;
                                const body = redact(args.body, secretValues);
                                const existing = state.messages.find(
                                  (message) => message.cause === cause,
                                );
                                if (existing) {
                                  if (existing.to !== args.to || existing.body !== body)
                                    throw new Error("Message key reused with different content");
                                  return existing.id;
                                }
                                if (state.messages.length >= config.limits.messages)
                                  throw new Error("Run message budget exhausted");
                                const message = {
                                  id: `message-${state.messages.length + 1}`,
                                  from: agent.id,
                                  to: args.to,
                                  body,
                                  cause,
                                };
                                state.messages.push(message);
                                await persist();
                                return message.id;
                              });
                              return {
                                content: [{ type: "text", text: JSON.stringify({ id: accepted }) }],
                                details: {},
                              };
                            },
                          }),
                        ],
                }),
              },
            }),
          );
          if (
            result.invocationId !== turn.id ||
            result.generation !== request.generation ||
            sha256(result.checkpoint) !== result.checkpointSha256
          )
            throw new Error("Executor returned mismatched identity or checkpoint hash");
          await transaction(async () => {
            await atomicJson(path.join(root, "results", `${turn.id}.json`), result);
            turn.status = "confirmed";
            turn.result = {
              outcome: result.outcome,
              text: result.text,
              usage: result.usage,
              error: result.error,
            };
            for (const message of state.messages)
              if (turn.deliveries.includes(message.id)) message.acknowledgedBy = turn.id;
            if (result.outcome !== "completed") {
              if (state.status === "running")
                state.status = result.outcome === "limited" ? "limited" : "failed";
              abort();
            }
            await persist();
          });
        } catch (error) {
          abort();
          await transaction(async () => {
            turn.status = "interrupted";
            turn.error = redact(
              error instanceof Error ? error.message : String(error),
              secretValues,
            ).slice(0, 4000);
            if (state.status === "running") state.status = "failed";
            await persist();
          });
        }
      })();
      active.set(turn.agentId, work);
    }

    // Replay only the identical invocation. Pi returns its confirmed cache or
    // refuses an ambiguous active-turn marker; it never blindly repeats shell effects.
    for (const turn of state.turns.filter((candidate) => candidate.status !== "confirmed")) {
      if (controller.signal.aborted) break;
      if (active.has(turn.agentId)) throw new Error("Stored overlapping agent invocations");
      launch(turn);
    }
    while (!controller.signal.aborted) {
      await transaction(async () => {
        for (const agent of config.agents) {
          if (active.size >= config.limits.concurrency || state.turns.length >= config.limits.turns)
            break;
          if (active.has(agent.id)) continue;
          const pending = state.messages.filter(
            (message) => message.to === agent.id && !message.acknowledgedBy,
          );
          if (!pending.length) continue;
          // Keep the invocation prompt within the core limit; unselected messages remain pending.
          const deliveries: typeof pending = [];
          let prompt = "Addressed inbox:\n";
          for (const message of pending) {
            const text = `${JSON.stringify({ id: message.id, from: message.from, body: message.body })}\n`;
            if (prompt.length + text.length > 190_000) break;
            prompt += text;
            deliveries.push(message);
          }
          if (!deliveries.length)
            throw new Error("An encoded inbox message exceeds the invocation prompt limit");
          const previous = [...state.turns]
            .reverse()
            .find((turn) => turn.agentId === agent.id && turn.status === "confirmed");
          const turn: Turn = {
            id: `turn-${state.turns.length + 1}`,
            agentId: agent.id,
            deliveries: deliveries.map((message) => message.id),
            prompt,
            previous: previous?.id ?? null,
            status: "prepared",
          };
          state.turns.push(turn);
          await persist();
          launch(turn);
        }
      });
      if (!active.size) break;
      await Promise.race(
        [...active].map(async ([id, promise]) => {
          await promise;
          active.delete(id);
        }),
      );
    }
    await Promise.all(active.values());
    await writes;
    if (options.signal?.aborted) state.status = "cancelled";
    else if (Date.now() - state.started >= config.limits.wallTimeMs) state.status = "limited";
    if (state.status === "running") {
      state.status = options.signal?.aborted
        ? "cancelled"
        : controller.signal.aborted || state.messages.some((message) => !message.acknowledgedBy)
          ? "limited"
          : "quiescent";
    }
    await atomicJson(filename, state);
    return state;
  } finally {
    abort();
    await Promise.allSettled(active.values());
    await writes;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await release();
  }
}

export async function readSwarmConfig(filename: string) {
  return swarmConfig.parse(JSON.parse(await readFile(filename, "utf8")));
}
