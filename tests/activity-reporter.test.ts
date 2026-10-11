import type { AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ActivityReporter } from "../src/agent/activity.js";
import { AgentBackend } from "../src/agent/backend.js";

class Backend extends AgentBackend {
  calls: Array<{ requestId: string; type: string; payload: unknown }> = [];
  fail = 0;
  constructor() {
    super({
      runId: "fixture-run",
      agentId: "a",
      invocationId: "invocation",
      generation: 1,
      backendUrl: "https://example.invalid",
      token: "fixture-agent-token-with-32-characters",
    });
  }
  override async request(_path: string, _method?: string, body?: unknown) {
    this.calls.push(body as (typeof this.calls)[number]);
    if (this.fail-- > 0) throw new Error("Harness request failed (503): lost acknowledgement");
    return { accepted: true };
  }
}
const message = (text: string): AssistantMessage => ({
  role: "assistant",
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  content: [{ type: "text", text }],
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

it("retries lost event acknowledgements with the same ID without repeating a tool", async () => {
  const backend = new Backend();
  backend.fail = 1;
  const reporter = new ActivityReporter(backend, "turn", "session", []);
  await reporter.record({
    type: "tool_execution_start",
    toolCallId: "call",
    toolName: "bash",
    args: { command: "npm test" },
  });
  await reporter.close();
  expect(backend.calls).toHaveLength(2);
  expect(backend.calls[0]!.requestId).toBe(backend.calls[1]!.requestId);
});

it("coalesces visible text and protects secrets split across provider chunks", async () => {
  const backend = new Backend();
  const secret = "private-model-secret-123456";
  const reporter = new ActivityReporter(backend, "turn", "session", [secret]);
  async function update(text: string) {
    const partial = message(text);
    await reporter.record({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial,
      },
    });
  }
  await update("Checking the parser");
  await update("Checking the parser now");
  await reporter.flush();
  expect(backend.calls).toHaveLength(1);
  expect(backend.calls[0]!.payload).toMatchObject({
    text: "Checking the parser now",
  });
  await update("key=" + secret.slice(0, 18));
  await reporter.flush();
  expect(JSON.stringify(backend.calls.at(-1))).not.toContain(secret.slice(0, 18));
  await update("key=" + secret);
  await reporter.close();
  expect(JSON.stringify(backend.calls)).not.toContain(secret);
  expect(backend.calls.at(-1)!.payload).toMatchObject({
    text: "key=[REDACTED]",
  });
});

it("bounds multibyte tool output and exposes failed uploads at invocation settlement", async () => {
  const backend = new Backend();
  const reporter = new ActivityReporter(backend, "turn", "session", []);
  await reporter.record({
    type: "tool_execution_end",
    toolCallId: "call",
    toolName: "read",
    isError: false,
    result: { content: "🙂".repeat(60000) },
  });
  expect(backend.calls[0]!.payload).toMatchObject({
    truncated: true,
    sha256: expect.any(String),
  });
  expect(Buffer.byteLength(JSON.stringify(backend.calls[0]!.payload))).toBeLessThan(128000);
  backend.fail = 3;
  await expect(
    reporter.record({
      type: "tool_execution_start",
      toolCallId: "next",
      toolName: "read",
      args: {},
    }),
  ).rejects.toThrow("503");
  await expect(reporter.close()).rejects.toThrow("Activity upload failed");
});
