import type { Fixture } from "./builder";
import { edgeStates } from "./edge-states";
import { happyPath } from "./happy-path";
import { recovery } from "./recovery";
import { thirdWorker } from "./third-worker";

export const FIXTURES: Record<string, () => Fixture> = {
  "happy-path": happyPath,
  recovery: recovery,
  "third-worker": thirdWorker,
  "edge-states": edgeStates,
};

export function toNdjson(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
