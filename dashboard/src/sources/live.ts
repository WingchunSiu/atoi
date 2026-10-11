import type { SendMessageRequest, SendMessageResponse } from "../contract/events";
import { ingest, type RunSource, type SendResult, type SourceSink } from "./types";

const RETRY_MS = 4000;

export interface RunSummary {
  id: string;
  objective?: string;
  status?: string;
  startedAt?: string;
  mock?: boolean;
}

export async function fetchRuns(signal?: AbortSignal): Promise<RunSummary[]> {
  const res = await fetch("/api/runs", { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /api/runs returned ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json"))
    throw new Error(
      "GET /api/runs did not return JSON. Is the backend (or npm run fake-sse) running?",
    );
  const body = (await res.json()) as { runs?: RunSummary[] };
  return Array.isArray(body.runs) ? body.runs : [];
}

/**
 * Opens an EventSource on /api/runs/:runId/events. The browser reconnects on its own and sends
 * Last-Event-ID; if the stream fails for good, we retry with ?after=<lastSeq>.
 */
export class LiveSource implements RunSource {
  readonly kind = "live" as const;
  private es: EventSource | undefined;
  private sink: SourceSink | undefined;
  private lastSeq = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    readonly runId: string,
    readonly mock: boolean,
  ) {}

  async send(req: SendMessageRequest): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(`/api/runs/${encodeURIComponent(this.runId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(req),
      });
    } catch (err) {
      return { ok: false, error: `Couldn't reach the backend (${String(err)}).` };
    }
    if (!res.ok) {
      const detail = await res
        .json()
        .then((b: { error?: string }) => b.error)
        .catch(() => undefined);
      const hint =
        res.status === 404 || res.status === 405 ? " The backend may not accept messages yet." : "";
      return {
        ok: false,
        status: res.status,
        error: `${detail ?? `The backend returned ${res.status}.`}${hint}`,
      };
    }
    const body = (await res.json().catch(() => ({}))) as Partial<SendMessageResponse>;
    return { ok: true, messageId: body.messageId ?? "" };
  }

  start(sink: SourceSink): () => void {
    this.sink = sink;
    this.stopped = false;
    this.open();
    return () => {
      this.stopped = true;
      clearTimeout(this.retryTimer);
      this.es?.close();
    };
  }

  retry() {
    clearTimeout(this.retryTimer);
    this.es?.close();
    this.open();
  }

  private open() {
    const sink = this.sink!;
    sink.status({ state: this.lastSeq ? "reconnecting" : "connecting" });
    const after = this.lastSeq ? `?after=${this.lastSeq}` : "";
    const es = new EventSource(`/api/runs/${encodeURIComponent(this.runId)}/events${after}`);
    this.es = es;
    es.onopen = () => sink.status({ state: "open" });
    es.onmessage = (msg) => {
      const seq = ingest(msg.data, sink);
      if (seq !== undefined && seq > this.lastSeq) this.lastSeq = seq;
    };
    es.onerror = () => {
      if (this.stopped) return;
      if (es.readyState === EventSource.CONNECTING) {
        sink.status({
          state: "reconnecting",
          message: "Lost connection to the backend. Reconnecting…",
        });
        return;
      }
      // Closed for good (for example a 404 or 500 on connect). Find out why, then retry.
      es.close();
      void this.diagnose();
    };
  }

  private async diagnose() {
    const sink = this.sink!;
    try {
      const runs = await fetchRuns();
      if (!runs.some((r) => r.id === this.runId)) {
        sink.status({
          state: "error",
          notFound: true,
          message: `Run ${this.runId} isn't on the backend. Pick another run.`,
        });
        return;
      }
    } catch {
      // Backend unreachable; fall through to the retry countdown.
    }
    if (this.stopped) return;
    sink.status({
      state: "error",
      retryInMs: RETRY_MS,
      message: "Lost connection to the backend.",
    });
    this.retryTimer = setTimeout(() => this.open(), RETRY_MS);
  }
}
