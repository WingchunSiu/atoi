import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let environment: TestWorkflowEnvironment;
const workflowsPath = fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url));
beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120000);
afterAll(async () => {
  await environment?.teardown();
});
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Temporal test worker did not process expected work");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("real Temporal service with fixture Activities", () => {
  it("resumes an agent workflow after worker restart and handles a queued peer wakeup", async () => {
    const taskQueue = "agent-restart-fixture";
    let turns = 0;
    let cleanup = 0;
    const createWorker = () =>
      Worker.create({
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath,
        stickyQueueScheduleToStartTimeout: "1 second",
        activities: {
          nextWakeup: async () => 60000,
          turn: async () => {
            turns++;
            return { work: false };
          },
          stopAgent: async () => {
            cleanup++;
          },
        },
      });
    const first = await createWorker();
    const firstRun = first.run();
    const handle = await environment.client.workflow.start("agentWorkflow", {
      workflowId: "agent/restart-fixture",
      taskQueue,
      args: ["restart-fixture"],
    });
    await until(() => turns === 1);
    first.shutdown();
    await firstRun;
    await handle.signal("wake");
    const second = await createWorker();
    const secondRun = second.run();
    try {
      await until(() => turns >= 2);
      await handle.signal("stop");
      await handle.result();
      expect(cleanup).toBe(1);
    } finally {
      second.shutdown();
      await secondRun;
    }
  }, 60000);

  it("enforces a durable run deadline independently of any planning agent", async () => {
    const expired: string[] = [];
    const taskQueue = "run-deadline-fixture";
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      stickyQueueScheduleToStartTimeout: "1 second",
      activities: {
        superviseRun: async () => ({ finished: false, nextCheckMs: 60000 }),
        expireRun: async (runId: string) => {
          expired.push(runId);
        },
      },
    });
    await worker.runUntil(() =>
      environment.client.workflow.execute("runSupervisor", {
        workflowId: "run/deadline-fixture",
        taskQueue,
        args: ["deadline-fixture", Date.now() + 2000],
      }),
    );
    expect(expired).toEqual(["deadline-fixture"]);
  }, 30000);
});

it("resumes run completion after worker restart and a queued checkpoint notification", async () => {
  const taskQueue = "completion-restart-fixture";
  let checks = 0;
  let checkpointReady = false;
  let expiration = 0;
  const createWorker = () =>
    Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      stickyQueueScheduleToStartTimeout: "1 second",
      activities: {
        superviseRun: async () => {
          checks++;
          return { finished: checkpointReady, nextCheckMs: 60000 };
        },
        expireRun: async () => {
          expiration++;
        },
      },
    });
  const first = await createWorker();
  const firstRun = first.run();
  const handle = await environment.client.workflow.start("runSupervisor", {
    workflowId: "run/completion-restart-fixture",
    taskQueue,
    args: ["completion-restart-fixture", Date.now() + 30000],
  });
  await until(() => checks === 1);
  first.shutdown();
  await firstRun;
  checkpointReady = true;
  await handle.signal("finish");
  const second = await createWorker();
  await second.runUntil(() => handle.result());
  expect(checks).toBeGreaterThanOrEqual(2);
  expect(expiration).toBe(0);
}, 60000);

it("preserves an idle workflow timer across a Temporal worker restart", async () => {
  const taskQueue = "timer-restart-fixture";
  let turns = 0;
  let timerReads = 0;
  const createWorker = () =>
    Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      stickyQueueScheduleToStartTimeout: "1 second",
      activities: {
        turn: async () => {
          turns++;
          return { work: false };
        },
        nextWakeup: async () => {
          timerReads++;
          return 1500;
        },
        stopAgent: async () => {},
      },
    });
  const first = await createWorker();
  const firstRun = first.run();
  const handle = await environment.client.workflow.start("agentWorkflow", {
    workflowId: "agent/timer-restart-fixture",
    taskQueue,
    args: ["timer-restart-fixture"],
  });
  await until(() => timerReads === 1);
  first.shutdown();
  await firstRun;
  const second = await createWorker();
  const secondRun = second.run();
  try {
    await until(() => turns >= 2);
    await handle.signal("stop");
    await handle.result();
    expect(turns).toBeGreaterThanOrEqual(2);
  } finally {
    second.shutdown();
    await secondRun;
  }
}, 60000);
