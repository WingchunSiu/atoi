import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentBackend } from "./backend.js";

type PiEvent = Parameters<Parameters<AgentSession["agent"]["subscribe"]>[0]>[0];

/** Coalesce visible text/partial results; important boundaries are awaited. */
export class ActivityReporter {
  private sequence = 0;
  private pending = new Map<string, { type: string; payload: unknown }>();
  private timer?: NodeJS.Timeout;
  private tail: Promise<void> = Promise.resolve();
  private failure?: Error;
  constructor(
    private backend: AgentBackend,
    private invocationId: string,
    private sessionId: string,
    private secrets: (string | undefined)[],
  ) {}

  private payload(value: unknown): unknown {
    let text = JSON.stringify(value);
    for (const secret of this.secrets)
      if (secret && secret.length >= 8) text = text.split(secret).join("[REDACTED]");
    if (Buffer.byteLength(text) <= 120000) return JSON.parse(text);
    return {
      truncated: true,
      sha256: createHash("sha256").update(text).digest("hex"),
      preview: text.slice(0, 16000),
    };
  }

  private upload(type: string, payload: unknown): Promise<void> {
    const body = {
      requestId: createHash("sha256")
        .update(`${this.invocationId}:activity:${++this.sequence}`)
        .digest("hex"),
      sessionId: this.sessionId,
      type,
      payload: this.payload(payload),
    };
    const next = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      for (let attempt = 0; ; attempt++) {
        try {
          // Atlas transactions plus a development tunnel can exceed three seconds.
          // Keep retries bounded while allowing ordinary cloud round trips.
          await this.backend.request("/events", "POST", body, AbortSignal.timeout(10000));
          return;
        } catch (error) {
          // A lost acknowledgement retries the exact event ID, never the Pi tool.
          if (attempt >= 2 || /\((400|401|403|404|409)\)/.test(String(error))) throw error;
          await delay(100 * (attempt + 1));
        }
      }
    });
    this.tail = next.catch((error: unknown) => {
      this.failure = new Error(
        `Activity upload failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    });
    return next;
  }

  private schedule(key: string, type: string, payload: unknown) {
    this.pending.set(key, { type, payload });
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {
        /* flush/close surfaces the retained error to the invocation */
      });
    }, 250);
  }

  async record(event: PiEvent): Promise<void> {
    if (this.failure) throw this.failure;
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta" && event.message.role === "assistant") {
        // Send a cumulative visible-text snapshot. This also redacts a secret
        // split across provider chunks once its full value has arrived.
        const text = event.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        let safeText = text;
        for (const secret of this.secrets) {
          if (!secret || secret.length < 8) continue;
          safeText = safeText.split(secret).join("[REDACTED]");
          for (let size = Math.min(secret.length - 1, safeText.length); size > 0; size--) {
            if (safeText.endsWith(secret.slice(0, size))) {
              safeText = safeText.slice(0, -size) + "[REDACTED]";
              break;
            }
          }
        }
        this.schedule(`message_${event.message.timestamp}`, "message_update", {
          messageId: String(event.message.timestamp),
          text: safeText,
        });
      }
      return;
    }
    if (event.type === "tool_execution_update") {
      this.schedule(event.toolCallId, event.type, event);
      return;
    }
    if (
      !["message_start", "message_end", "tool_execution_start", "tool_execution_end"].includes(
        event.type,
      )
    )
      return;
    await this.flush();
    let payload: unknown = event;
    if (
      (event.type === "message_start" || event.type === "message_end") &&
      event.message.role === "assistant"
    ) {
      payload = {
        ...event,
        message: {
          ...event.message,
          content: event.message.content.filter((part) => part.type !== "thinking"),
        },
      };
    }
    await this.upload(event.type, payload);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) await this.upload(item.type, item.payload);
    await this.tail;
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    await this.flush();
  }
}
