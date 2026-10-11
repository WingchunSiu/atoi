import type { SendMessageRequest } from "../contract/events";
import { parseEvent } from "../contract/events";
import { type RunState, reduce } from "../state/reduce";
import {
  activitySchema,
  type BackendSnapshot,
  emptyBackendState,
  overlaySnapshot,
  projectActivity,
  snapshotSchema,
} from "./backend";
import type { RunSource, SendResult, SourceSink } from "./types";

export interface RunSummary {
  id: string;
  objective?: string;
  status?: string;
  startedAt?: string;
  mock?: boolean;
}
export async function requestApi(path: string, options: RequestInit = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-atoi-browser": "1",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? `Backend returned ${response.status}`);
  }
  return response.json();
}
export async function fetchRuns(signal?: AbortSignal): Promise<RunSummary[]> {
  const rows: Array<{
    _id: string;
    objective: string;
    status: string;
    createdAt: string;
    archivedAt?: string;
  }> = await requestApi("/runs", { signal });
  if (!Array.isArray(rows)) throw new Error("Backend did not return a run list");
  return rows
    .filter((r) => !r.archivedAt)
    .map((r) => ({
      id: r._id,
      objective: r.objective,
      status: r.status,
      startedAt: r.createdAt,
    }));
}
export class LiveSource implements RunSource {
  readonly kind = "live" as const;
  private es?: EventSource;
  private sink?: SourceSink;
  private snapshot?: BackendSnapshot;
  private state: RunState;
  private cursor = 0;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private abort?: AbortController;
  private tail = Promise.resolve();
  private refreshing = false;
  constructor(
    readonly runId: string,
    readonly mock = false,
  ) {
    this.state = emptyBackendState(runId);
  }
  async send(req: SendMessageRequest): Promise<SendResult> {
    try {
      if (!req.to && !this.snapshot) await this.refresh();
      const planner = this.snapshot?.agents.find((a) => a.kind === "orchestrator")?._id;
      if (!req.to && !planner)
        throw new Error("The orchestrator is not available yet. Please retry.");
      const message = await requestApi(`/runs/${this.runId}/messages`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          requestId: req.clientRequestId,
          body: req.body,
          recipientId: req.to || undefined,
          // Human team messages address the planner; peer broadcasts remain opt-in.
          mentions: req.to ? [] : [planner],
        }),
      });
      return { ok: true, messageId: message._id };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
  async stop() {
    await requestApi(`/runs/${this.runId}/stop`, { method: "POST", body: "{}" });
    await this.refresh();
  }
  start(sink: SourceSink) {
    this.sink = sink;
    this.abort = new AbortController();
    void this.open().catch((error) => sink.status({ state: "error", message: String(error) }));
    return () => {
      this.abort?.abort();
      this.es?.close();
      clearInterval(this.refreshTimer);
    };
  }
  retry() {
    this.es?.close();
    void this.open().catch((error) =>
      this.sink?.status({ state: "error", message: String(error) }),
    );
  }
  private async refresh() {
    if (this.refreshing || this.abort?.signal.aborted) return;
    this.refreshing = true;
    try {
      this.snapshot = snapshotSchema.parse(
        await requestApi(`/runs/${this.runId}`, { signal: this.abort?.signal }),
      );
      if (this.cursor >= (this.snapshot.run.eventSequence ?? 0)) {
        this.state = overlaySnapshot(this.state, this.snapshot);
        this.sink?.snapshot?.(this.state);
      }
    } finally {
      this.refreshing = false;
    }
  }
  private async open() {
    this.sink!.status({ state: this.cursor ? "reconnecting" : "connecting" });
    await this.refresh();
    if (this.abort?.signal.aborted) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(
      () =>
        void this.refresh().catch((error) =>
          this.sink?.status({ state: "reconnecting", message: String(error) }),
        ),
      2000,
    );
    const es = new EventSource(`/api/runs/${this.runId}/events/stream?after=${this.cursor}`);
    this.es = es;
    es.onopen = () => this.sink?.status({ state: "open" });
    es.addEventListener("activity", (raw) => {
      this.tail = this.tail
        .then(async () => {
          if (this.abort?.signal.aborted) return;
          const event = activitySchema.parse(JSON.parse((raw as MessageEvent).data));
          if (event.runId !== this.runId) throw new Error("Activity belongs to another run");
          if (event.sequence <= this.cursor) return;
          // Entity references may not be in the initial snapshot when a peer just joined.
          if (
            [
              "task.created",
              "task.claimed",
              "task.updated",
              "agent.spawned",
              "message.sent",
            ].includes(event.type)
          )
            await this.refresh();
          let message = this.snapshot!.messages.find((m) => m._id === event.entityId);
          if (event.type === "message.sent" && !message)
            message = await requestApi(`/runs/${this.runId}/messages/${event.entityId}`);
          for (const projected of projectActivity(event, this.snapshot!, message)) {
            const parsed = parseEvent(projected);
            if (!parsed.ok) throw new Error(parsed.error);
            this.state = reduce(this.state, parsed.event);
            this.sink!.event(parsed.event);
          }
          this.cursor = event.sequence;
          if (this.cursor >= (this.snapshot!.run.eventSequence ?? 0)) {
            this.state = overlaySnapshot(this.state, this.snapshot!);
            this.sink?.snapshot?.(this.state);
          }
        })
        .catch((error) => {
          this.sink?.malformed(String(error), undefined);
          this.sink?.status({ state: "error", message: String(error) });
          es.close();
        });
    });
    es.addEventListener("stream_error", () =>
      this.sink?.status({ state: "reconnecting", message: "Backend activity source unavailable" }),
    );
    es.onerror = () => {
      if (!this.abort?.signal.aborted)
        this.sink?.status({
          state: "reconnecting",
          message: "Replaying persisted activity after reconnect",
        });
    };
  }
}
