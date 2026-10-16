import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  harnessId,
  type PiInvocation,
  type PiResult,
  piInvocation,
  piResult,
} from "./contracts.js";
import { type AgentPlacement, agentPlacement } from "./placement.js";
import { invocationUsage } from "./usage.js";

type PiEvent = Parameters<Parameters<AgentSession["agent"]["subscribe"]>[0]>[0];

export interface PiObserver {
  // Called in source order; observers own I/O serialization and stream coalescing.
  record(event: PiEvent): Promise<void>;
  close(): Promise<void>;
}

export interface PiRuntimeOptions {
  placement: AgentPlacement;
  profile: {
    // Change the profile ID when tool behavior changes; it participates in retry identity.
    id: string;
    systemPrompt: string;
    bind?: (context: {
      sessionId: string;
      invocation: PiInvocation;
      placement: AgentPlacement;
    }) => {
      tools?: ToolDefinition[];
      observer?: PiObserver;
    };
  };
  // Adapters can include an opaque fingerprint of extra transport/configuration inputs.
  cacheContext?: string;
  secrets?: (string | undefined)[];
  signal?: AbortSignal;
  // Tests replace inference only; Pi still executes its own tools and native sessions.
  configureSession?: (session: AgentSession) => void | Promise<void>;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function redact(text: string, secrets: (string | undefined)[]): string {
  for (const secret of secrets)
    if (secret && secret.length >= 8) text = text.split(secret).join("[REDACTED]");
  return text;
}

export async function executePiTurn(
  input: PiInvocation,
  options: PiRuntimeOptions,
): Promise<PiResult> {
  const request = piInvocation.parse(input);
  const placement = agentPlacement.parse(options.placement);
  harnessId.parse(options.profile.id);
  if (placement.agentId !== request.agentId || placement.runId !== request.runId)
    throw new Error("Invocation identity does not match its placement");
  if (options.signal?.aborted) throw new Error("Invocation cancelled before execution");
  const { workspace, stateDirectory } = placement;
  await mkdir(stateDirectory, { recursive: true });
  const fingerprint = sha256(
    JSON.stringify({
      request,
      placement,
      profileId: options.profile.id,
      systemPrompt: options.profile.systemPrompt,
      cacheContext: options.cacheContext,
    }),
  );
  const cachePath = path.join(stateDirectory, `${request.invocationId}.json`);
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as {
      fingerprint: string;
      result: unknown;
    };
    if (cached.fingerprint !== fingerprint)
      throw new Error("Invocation ID reused with different input");
    return piResult.parse(cached.result);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lock = path.join(stateDirectory, "active-turn");
  try {
    await mkdir(lock);
  } catch {
    throw new Error("An active or interrupted invocation exists; inspect it before retrying");
  }
  await writeFile(
    path.join(lock, "invocation.json"),
    JSON.stringify({
      invocationId: request.invocationId,
      generation: request.generation,
    }),
  );
  let session: AgentSession | undefined;
  let timer: NodeJS.Timeout | undefined;
  let cancelTurn: (() => void) | undefined;
  let confirmed = false;
  const secrets = [
    ...(options.secrets ?? []),
    process.env.ATOI_MODEL_API_KEY,
    process.env.GITHUB_TOKEN,
  ];
  const started = Date.now();
  try {
    const sessionPath = path.join(stateDirectory, "session.jsonl");
    let manager: SessionManager;
    if (request.checkpoint) {
      // Restore Pi's complete native entry tree, including compaction and tool results.
      for (const line of request.checkpoint.trim().split("\n")) JSON.parse(line);
      await writeFile(sessionPath, request.checkpoint);
      manager = SessionManager.open(sessionPath, stateDirectory, workspace);
    } else {
      manager = SessionManager.create(workspace, stateDirectory);
    }
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(stateDirectory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    if (process.env.ATOI_MODEL_API_KEY)
      await modelRuntime.setRuntimeApiKey(request.provider, process.env.ATOI_MODEL_API_KEY);
    const model = modelRuntime.getModel(request.provider, request.model);
    if (!model)
      throw new Error(
        `Pi has no model ${request.provider}/${request.model}; configure a supported catalog model`,
      );
    const settings = SettingsManager.inMemory({
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: path.join(stateDirectory, "pi"),
      settingsManager: settings,
      appendSystemPromptOverride: (base) => [...base, options.profile.systemPrompt],
    });
    await loader.reload();
    const bindings = options.profile.bind?.({
      sessionId: manager.getHeader()!.id,
      invocation: request,
      placement,
    });
    ({ session } = await createAgentSession({
      cwd: workspace,
      agentDir: path.join(stateDirectory, "pi"),
      sessionManager: manager,
      settingsManager: settings,
      resourceLoader: loader,
      modelRuntime,
      model,
      customTools: bindings?.tools ?? [],
    }));
    await options.configureSession?.(session);
    let modelRequests = 0;
    let toolCalls = 0;
    let limited: string | undefined;
    const observer = bindings?.observer;
    const pendingObservations = new Set<Promise<void>>();
    let observerFailure: unknown;

    const originalStream = session.agent.streamFunction;
    session.agent.streamFunction = (...args) => {
      if (modelRequests >= request.budget.modelRequests) {
        limited = "Model request budget exhausted";
        throw new Error(limited);
      }
      modelRequests++;
      return originalStream(...args);
    };
    const originalBeforeTool = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      if (++toolCalls > request.budget.toolCalls) {
        limited = "Tool call budget exhausted";
        return { block: true, reason: limited };
      }
      return originalBeforeTool?.(context, signal);
    };
    const unsubscribe = session.agent.subscribe((event) => {
      if (observer) {
        try {
          const pending = observer.record(event).catch((caught: unknown) => {
            observerFailure ??= caught;
          });
          pendingObservations.add(pending);
          void pending.then(() => pendingObservations.delete(pending));
        } catch (caught) {
          observerFailure ??= caught;
        }
      }
    });
    timer = setTimeout(() => {
      limited = "Invocation time budget exhausted";
      void session?.abort();
    }, request.budget.timeoutMs);
    let cancelled = false;
    cancelTurn = () => {
      cancelled = true;
      void session?.abort();
    };
    options.signal?.addEventListener("abort", cancelTurn, { once: true });
    let error: string | undefined;
    try {
      if (options.signal?.aborted) throw new Error("Invocation cancelled before model call");
      await session.prompt(request.prompt);
    } catch (caught) {
      error = redact(caught instanceof Error ? caught.message : String(caught), secrets);
    } finally {
      unsubscribe();
      try {
        await Promise.all(pendingObservations);
        await observer?.close();
        if (observerFailure) throw observerFailure;
      } catch (caught) {
        error = redact(caught instanceof Error ? caught.message : String(caught), secrets);
      }
    }
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      lastAssistant?.role === "assistant" &&
      ["error", "aborted"].includes(lastAssistant.stopReason)
    )
      error ??= lastAssistant.errorMessage ?? "Pi invocation did not finish";
    if (cancelled) error = "Invocation cancelled";
    const nativeSession = await readFile(manager.getSessionFile()!, "utf8").catch(
      (caught: NodeJS.ErrnoException) => {
        if (caught.code !== "ENOENT") throw caught;
        // Pi may reject missing credentials before persisting its first message.
        // Preserve the native header/setup entries and return an explicit failure.
        return (
          [manager.getHeader(), ...manager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n"
        );
      },
    );
    const checkpoint = redact(nativeSession, secrets);
    const result = piResult.parse({
      invocationId: request.invocationId,
      generation: request.generation,
      outcome: limited ? "limited" : error ? "failed" : "completed",
      text: redact(session.getLastAssistantText() ?? "", secrets).slice(0, 128_000),
      checkpoint,
      checkpointSha256: sha256(checkpoint),
      usage: {
        ...invocationUsage(nativeSession, request.checkpoint),
        toolCalls,
        modelRequests,
        elapsedMs: Date.now() - started,
      },
      error: (limited ?? error)?.slice(0, 4000),
    });
    await writeFile(`${cachePath}.tmp`, JSON.stringify({ fingerprint, result }));
    await rename(`${cachePath}.tmp`, cachePath);
    confirmed = true;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (cancelTurn) options.signal?.removeEventListener("abort", cancelTurn);
    session?.dispose();
    if (confirmed) await rm(lock, { recursive: true, force: true });
  }
}
