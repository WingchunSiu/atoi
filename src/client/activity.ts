export interface Activity {
  _id: string;
  runId: string;
  agentId: string;
  invocationId?: string;
  sessionId?: string;
  generation: number;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

/** Small fetch-based SSE client: bearer auth, replay cursor, cancellation. */
export async function watchActivity(options: {
  baseUrl: string;
  token: string;
  runId: string;
  agentId?: string;
  after?: number;
  signal: AbortSignal;
  onEvent: (event: Activity) => void | Promise<void>;
  onConnection?: (state: "connecting" | "live" | "reconnecting", error?: string) => void;
}) {
  let cursor = options.after ?? 0;
  let failures = 0;
  while (!options.signal.aborted) {
    options.onConnection?.(failures ? "reconnecting" : "connecting");
    try {
      const url = new URL(
        `/operator/runs/${encodeURIComponent(options.runId)}/events/stream`,
        options.baseUrl,
      );
      url.searchParams.set("after", String(cursor));
      if (options.agentId) url.searchParams.set("agentId", options.agentId);
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${options.token}`,
          "last-event-id": String(cursor),
        },
        signal: options.signal,
      });
      if (!response.ok) {
        const error = new Error(
          `Activity feed returned ${response.status}: ${await response.text()}`,
        );
        if (response.status >= 400 && response.status < 500 && response.status !== 429)
          throw new FatalFeedError(error.message);
        throw error;
      }
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
        throw new FatalFeedError("Server did not return an activity stream");
      options.onConnection?.("live");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let frame: string[] = [];
      async function dispatch() {
        const lines = frame;
        frame = [];
        const type = lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (type === "stream_error") throw new Error("Activity source unavailable; reconnecting");
        if (type !== "activity" || !data) return;
        const event = JSON.parse(data) as Activity;
        const rawId = lines
          .find((line) => line.startsWith("id:"))
          ?.slice(3)
          .trim();
        if (
          !Number.isSafeInteger(event.sequence) ||
          event.sequence < 1 ||
          String(event.sequence) !== rawId ||
          event.runId !== options.runId ||
          (options.agentId && event.agentId !== options.agentId)
        )
          throw new FatalFeedError("Invalid activity frame");
        if (event.sequence <= cursor) return;
        try {
          await options.onEvent(event);
        } catch (error) {
          throw new FatalFeedError(`Activity consumer failed: ${String(error)}`);
        }
        cursor = event.sequence;
        failures = 0;
      }
      try {
        while (!options.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (!line) await dispatch();
            else if (!line.startsWith(":")) frame.push(line);
          }
          if (buffer.length + frame.join("\n").length > 256000)
            throw new FatalFeedError("Activity frame exceeds limit");
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!options.signal.aborted) throw new Error("Activity connection closed");
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof FatalFeedError) throw error;
      options.onConnection?.(
        "reconnecting",
        error instanceof Error ? error.message : "Connection lost",
      );
      failures++;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(1000 * 2 ** Math.min(failures - 1, 4), 15000));
        options.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}

class FatalFeedError extends Error {}
