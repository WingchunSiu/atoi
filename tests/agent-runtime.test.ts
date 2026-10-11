import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBackend } from "../src/agent/backend.js";
import { executeTurn } from "../src/agent/runtime.js";
import type { WorkerRequest } from "../src/contracts/runtime.js";
import { scriptedPi, tool } from "./scripted-pi.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const request = (invocationId: string, checkpoint: string | null = null): WorkerRequest => ({
  agentId: "agent-a",
  runId: "fixture-run",
  invocationId,
  generation: 1,
  role: "developer",
  kind: "worker",
  instructions: "Reuse your knowledge and consult peers.",
  prompt: "Inspect the workspace and consult the reviewer.",
  backendUrl: "https://example.invalid",
  token: "test-only-agent-token-32-characters",
  provider: "openai",
  model: "gpt-4.1",
  checkpoint,
  budget: { timeoutMs: 10000, modelRequests: 8, toolCalls: 8 },
});

class ScriptedBackend extends AgentBackend {
  calls: Array<{ path: string; body: unknown }> = [];
  constructor() {
    super(request("fixture"));
  }
  override async request(path: string, _method?: string, body?: unknown): Promise<unknown> {
    this.calls.push({ path, body });
    return path.startsWith("/agents")
      ? { items: [{ _id: "agent-b", role: "reviewer" }] }
      : { _id: "fixture-channel", accepted: true };
  }
}

async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), "atoi-agent-test-"));
  directories.push(workspace);
  return {
    workspace,
    stateDirectory: path.join(workspace, ".state"),
    backend: new ScriptedBackend(),
  };
}

describe("Pi guest persistence with a scripted model", () => {
  it("keeps native tools, checkpoints the session, restores context in a new workspace, and adds peer tools", async () => {
    const first = await fixture();
    const result = await executeTurn(request("turn-one"), {
      ...first,
      async configureSession(session) {
        expect(session.getActiveToolNames()).toEqual(
          expect.arrayContaining(["read", "bash", "edit", "write", "send_message", "list_agents"]),
        );
        expect(session.getActiveToolNames()).not.toContain("spawn_agent");
        expect(session.getActiveToolNames()).not.toContain("complete_objective");
        await scriptedPi(session, [
          [
            tool("write-call", "write", {
              path: "memory.txt",
              content: "Evidence: the parser rejects empty input.",
            }),
          ],
          [
            tool("find-peer", "list_agents", {}),
            tool("peer:call/with-special-characters", "send_message", {
              recipientId: "agent-b",
              body: "Please verify the parser edge case.",
            }),
          ],
          "Remember the verified finding: empty input triggers the parser bug.",
        ]);
      },
    });
    expect(result.outcome).toBe("completed");
    expect(await readFile(path.join(first.workspace, "memory.txt"), "utf8")).toContain("parser");
    const sent = first.backend.calls.find((call) => call.path.endsWith("/messages"))!;
    expect(sent.body).toMatchObject({
      requestId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.checkpoint).toContain('"type":"session"');
    expect(result.checkpoint).toContain('"role":"toolResult"');
    const replacement = await fixture();
    let restored = "";
    const recovered = await executeTurn(
      { ...request("turn-two", result.checkpoint), generation: 2 },
      {
        ...replacement,
        async configureSession(session) {
          await scriptedPi(session, ["The prior finding remains available."], (context) => {
            restored = context;
          });
        },
      },
    );
    expect(recovered.outcome).toBe("completed");
    expect(restored).toContain("empty input triggers the parser bug");
    expect(restored).toContain("Please verify the parser edge case");
    expect(recovered.checkpoint).toContain("The prior finding remains available");
  });

  it("records session-linked working notes without exposing the worker credential", async () => {
    const options = await fixture();
    const input = request("working-note-turn");
    const result = await executeTurn(input, {
      ...options,
      async configureSession(session) {
        await scriptedPi(session, [
          [
            tool("log", "write_work_log", {
              note: `Investigated parser behavior. Credential: ${input.token}`,
              nextStep: "Add a regression test",
              evidence: ["parser.ts"],
            }),
          ],
          "Working note saved.",
        ]);
      },
    });
    expect(result.outcome).toBe("completed");
    const saved = options.backend.calls.find((call) => call.path === "/logs")!;
    const sessionId = JSON.parse(result.checkpoint.split("\n")[0]!).id;
    expect(saved.body).toMatchObject({
      sessionId,
      note: expect.stringContaining("[REDACTED]"),
    });
    expect(JSON.stringify(options.backend.calls)).not.toContain(input.token);
    expect(result.checkpoint).not.toContain(input.token);
  });

  it("reuses a confirmed invocation without repeating filesystem effects", async () => {
    const options = await fixture();
    const input = request("deduplicated-turn");
    const first = await executeTurn(input, {
      ...options,
      async configureSession(session) {
        await scriptedPi(session, [
          [
            tool("append", "bash", {
              command: "printf 'once\\n' >> effects.txt",
            }),
          ],
          "Done.",
        ]);
      },
    });
    const duplicate = await executeTurn(input, {
      ...options,
      configureSession() {
        throw new Error("Cached invocation must not create another Pi session");
      },
    });
    expect(duplicate).toEqual(first);
    expect(await readFile(path.join(options.workspace, "effects.txt"), "utf8")).toBe("once\n");
    await expect(executeTurn({ ...input, prompt: "Different work" }, options)).rejects.toThrow(
      "different input",
    );
  });

  it("bounds model requests rather than running an unlimited loop", async () => {
    const options = await fixture();
    const input = {
      ...request("limited-turn"),
      budget: { timeoutMs: 10000, modelRequests: 1, toolCalls: 8 },
    };
    const result = await executeTurn(input, {
      ...options,
      async configureSession(session) {
        await scriptedPi(session, [
          [tool("read-dir", "bash", { command: "pwd" })],
          "Must not request this model response.",
        ]);
      },
    });
    expect(result.outcome).toBe("limited");
    expect(result.error).toContain("Model request budget");
    expect(result.checkpoint).toContain("pwd");
  });

  it("retains an inspection marker if no confirmed result was produced", async () => {
    const options = await fixture();
    await expect(
      executeTurn({ ...request("broken-turn"), model: "nonexistent-model" }, options),
    ).rejects.toThrow("Pi has no model");
    await expect(executeTurn(request("another-turn"), options)).rejects.toThrow(
      "interrupted invocation",
    );
  });
});

it("uses the configured endpoint through Pi's real HTTP stream and exposes orchestration tools only to its orchestrator", async () => {
  const calls: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    calls.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(text) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "custom-model",
    };
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Endpoint connected." }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  vi.stubEnv("ATOI_MODEL_API_KEY", "fixture-custom-endpoint-key");
  try {
    const response = await executeTurn(
      {
        ...request("custom-endpoint"),
        kind: "orchestrator",
        provider: "fixture-provider",
        model: "custom-model",
        modelBaseUrl: `http://127.0.0.1:${port}/v1`,
      },
      {
        ...(await fixture()),
        configureSession(session) {
          expect(session.getActiveToolNames()).toEqual(
            expect.arrayContaining(["spawn_agent", "complete_objective"]),
          );
        },
      },
    );
    expect(response.outcome).toBe("completed");
    expect(response.text).toBe("Endpoint connected.");
    expect(response.usage.costKnown).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "/v1/chat/completions",
      authorization: "Bearer fixture-custom-endpoint-key",
      body: { model: "custom-model", stream: true },
    });
    expect(response.checkpoint).not.toContain("fixture-custom-endpoint-key");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
