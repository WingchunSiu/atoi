import type { SendMessageRequest } from "../contract/events";
import { ingest, type RunSource, type SendResult, type SourceSink } from "./types";

export const operatorToken = () => sessionStorage.getItem("atoi.operatorToken") ?? "";
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${operatorToken()}`,
      ...init.headers,
    },
  });
  const body = await response
    .json()
    .catch(() => ({ message: "Backend did not return JSON. Check the API proxy." }));
  if (!response.ok) throw new Error(body.message ?? `Backend returned ${response.status}`);
  return body as T;
}
export interface RunSummary {
  id: string;
  objective?: string;
  status?: string;
  startedAt?: string;
  mock?: boolean;
}
export async function fetchRuns(signal?: AbortSignal): Promise<RunSummary[]> {
  const runs = await api<
    Array<{ _id: string; objective: string; status: string; createdAt: string; mock?: boolean }>
  >("/runs", { signal });
  return runs.map((run) => ({
    id: run._id,
    objective: run.objective,
    status: run.status,
    startedAt: run.createdAt,
    mock: !!run.mock,
  }));
}

/** Poll persisted pages with an abortable request; browser lifetime never owns run lifetime. */
export class LiveSource implements RunSource {
  readonly kind = "live" as const;
  private cursor = 0;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private sink?: SourceSink;
  constructor(
    readonly runId: string,
    readonly mock = false,
  ) {}
  async send(req: SendMessageRequest): Promise<SendResult> {
    try {
      const message = await api<{ _id: string }>(
        `/runs/${encodeURIComponent(this.runId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            requestId: req.clientRequestId,
            body: req.body,
            ...(req.to === "team" ? {} : { recipientId: req.to }),
            mentions: [],
          }),
        },
      );
      return { ok: true, messageId: message._id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  start(sink: SourceSink): () => void {
    this.sink = sink;
    this.retry();
    return () => {
      this.abort?.abort();
      clearTimeout(this.timer);
      this.sink = undefined;
    };
  }
  retry() {
    this.abort?.abort();
    clearTimeout(this.timer);
    this.abort = new AbortController();
    void this.poll(this.abort.signal);
  }
  private async poll(signal: AbortSignal) {
    if (!this.sink || signal.aborted) return;
    try {
      let more = true;
      while (more && !signal.aborted) {
        const page = await api<{ events: unknown[]; cursor: number; hasMore: boolean }>(
          `/runs/${encodeURIComponent(this.runId)}/dashboard-events?after=${this.cursor}`,
          { signal },
        );
        if (signal.aborted || !this.sink) return;
        for (const event of page.events) ingest(JSON.stringify(event), this.sink);
        this.cursor = page.cursor;
        more = page.hasMore;
      }
      this.sink?.status({ state: "open" });
      this.timer = setTimeout(() => void this.poll(signal), 1500);
    } catch (error) {
      if (signal.aborted || !this.sink) return;
      this.sink.status({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
        retryInMs: 4000,
      });
      this.timer = setTimeout(() => void this.poll(signal), 4000);
    }
  }
}
