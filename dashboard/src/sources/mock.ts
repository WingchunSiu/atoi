import type { SendMessageRequest } from "../contract/events";
import { MockRun, type RawEvent } from "./mockRun";
import { ingest, type RunSource, type SendResult, type SourceSink } from "./types";

/**
 * Plays a scripted fixture in the browser as if it were a live run. Events go through the
 * same JSON parsing and validation as the live stream.
 */
export class MockSource implements RunSource {
  readonly kind = "mock" as const;
  readonly mock = true;
  private run: MockRun | undefined;

  constructor(
    readonly fixture: string,
    private readonly speed = 1,
  ) {}

  get runId() {
    return this.run?.runId;
  }

  start(sink: SourceSink): () => void {
    let stopped = false;
    let unsubscribe = () => {};
    sink.status({ state: "connecting" });
    // Fixtures load on demand so they stay out of the live bundle.
    import("../../fixtures/index").then(({ FIXTURES }) => {
      if (stopped) return;
      const build = FIXTURES[this.fixture];
      if (!build) {
        sink.status({
          state: "error",
          message: `There's no fixture called "${this.fixture}". Try one of: ${Object.keys(FIXTURES).join(", ")}.`,
        });
        return;
      }
      this.run = new MockRun(build().events as RawEvent[], this.speed);
      unsubscribe = this.run.onEvent((e) => ingest(JSON.stringify(e), sink));
      sink.status({ state: "open" });
      this.run.start();
    });
    return () => {
      stopped = true;
      unsubscribe();
      this.run?.stop();
    };
  }

  async send(req: SendMessageRequest): Promise<SendResult> {
    if (!this.run) return { ok: false, error: "The mock run hasn't started yet." };
    return this.run.send(req);
  }
}
