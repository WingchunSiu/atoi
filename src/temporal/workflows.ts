import {
  ActivityFailure,
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { Activities } from "./activities.js";

export const wake = defineSignal("wake");
export const stop = defineSignal("stop");
export const finish = defineSignal("finish");
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
    const nextWakeupMs = awake ? 0 : await lifecycle.nextWakeup(agentId);
    await condition(() => awake || stopping, Math.min(60000, nextWakeupMs));
    if (stopping) break;
    awake = false;
    try {
      const result = await activities.turn(agentId);
      awake ||= result.work;
    } catch (error) {
      if (stopping) break;
      // A completed Atlas checkpoint wins over a lost Activity acknowledgement.
      // Unconfirmed work is quarantined; a failed report is reconciled later.
      const result = await lifecycle.failAgent(
        agentId,
        workflowInfo().runId,
        error instanceof ActivityFailure ? error.activityId : undefined,
      );
      if (!result.work) return;
      awake = true;
    }
    if (++iterations >= 100) await continueAsNew<typeof agentWorkflow>(agentId, awake);
  }
  await lifecycle.stopAgent(agentId);
}

export async function runSupervisor(runId: string, deadlineMs: number): Promise<void> {
  let stopping = false;
  let changed = false;
  let iterations = 0;
  setHandler(stop, () => {
    stopping = true;
  });
  setHandler(finish, () => {
    changed = true;
  });
  while (!stopping && Date.now() < deadlineMs) {
    changed = false;
    const state = await lifecycle.superviseRun(runId);
    if (state.finished) return;
    await condition(
      () => stopping || changed,
      Math.max(1, Math.min(state.nextCheckMs, deadlineMs - Date.now())),
    );
    if (++iterations >= 100 && !stopping)
      await continueAsNew<typeof runSupervisor>(runId, deadlineMs);
  }
  await lifecycle.expireRun(runId);
}

export async function cleanupAgentWorkflow(agentId: string): Promise<void> {
  await lifecycle.stopAgent(agentId);
}
