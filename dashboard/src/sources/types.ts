import type { DashboardEvent, SendMessageRequest } from "../contract/events";
import { parseEvent } from "../contract/events";
import type { RunState } from "../state/reduce";

export type SourceKind = "live" | "mock";

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; status?: number; error: string };

export interface SourceStatus {
  state: "connecting" | "open" | "reconnecting" | "closed" | "error";
  retryInMs?: number;
  message?: string;
  /** Set when the backend says the run doesn't exist. */
  notFound?: boolean;
}

export interface SourceSink {
  snapshot?(state: RunState): void;
  event(e: DashboardEvent): void;
  status(s: SourceStatus): void;
  /** A line that wasn't valid JSON or failed validation. */
  malformed(reason: string, raw: unknown): void;
}

export interface RunSource {
  kind: SourceKind;
  /** True when the data is scripted: fixtures, the fake SSE server, or a backend run marked mock. */
  mock: boolean;
  runId?: string;
  start(sink: SourceSink): () => void; // returns stop
  /** Reconnect immediately, if the source supports it. */
  retry?(): void;
  /** Send the operator's message (POST /api/runs/:runId/messages). */
  send(req: SendMessageRequest): Promise<SendResult>;
  stop?(): Promise<void>;
}

/** Parse one JSON text (an NDJSON line or an SSE data field) into the sink. Returns the seq if valid. */
export function ingest(text: string, sink: SourceSink): number | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.warn("[atoi] skipped event: invalid JSON", err, text);
    sink.malformed("invalid JSON", text);
    return undefined;
  }
  const result = parseEvent(raw);
  if (!result.ok) {
    console.warn(`[atoi] skipped event: ${result.error}`, raw);
    sink.malformed(result.error, raw);
    return undefined;
  }
  sink.event(result.event);
  return result.event.seq;
}
