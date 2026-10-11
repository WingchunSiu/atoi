import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { Activities } from "./activities.js";

export const wake = defineSignal("wake");
export const stop = defineSignal("stop");
const activities = proxyActivities<Activities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    maximumInterval: "10 seconds",
  },
});
// Cleanup and database-only Activities do not rely on a model-turn heartbeat.
const lifecycle = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2 seconds",
    maximumInterval: "30 seconds",
  },
});

export async function agentWorkflow(agentId: string, pendingWake = true): Promise<void> {
  let awake = pendingWake;
  let stopping = false;
  let iterations = 0;
  setHandler(wake, () => {
    awake = true;
  });
  setHandler(stop, () => {
    stopping = true;
  });
  while (!stopping) {
    // A durable timer also reconciles missed notifications against the Atlas inbox.
    await condition(() => awake || stopping, "1 minute");
    if (stopping) break;
    awake = false;
    const result = await activities.turn(agentId);
    awake ||= result.work;
    if (++iterations >= 100) await continueAsNew<typeof agentWorkflow>(agentId, awake);
  }
  await lifecycle.stopAgent(agentId);
}

export async function runSupervisor(runId: string, deadlineMs: number): Promise<void> {
  let stopping = false;
  setHandler(stop, () => {
    stopping = true;
  });
  await condition(() => stopping, Math.max(0, deadlineMs - Date.now()));
  await lifecycle.expireRun(runId);
}

export async function cleanupAgentWorkflow(agentId: string): Promise<void> {
  await lifecycle.stopAgent(agentId);
}
