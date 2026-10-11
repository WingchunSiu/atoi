import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { expect, it } from "vitest";
import { executeTurn } from "../src/agent/runtime.js";
import { createServer } from "../src/api/server.js";
import { runInput, type WorkerRequest, type WorkerResult } from "../src/contracts/runtime.js";
import type { Agent } from "../src/model.js";
import { MongoStore } from "../src/store/mongo.js";
import { createActivities } from "../src/temporal/activities.js";
import { reconcile } from "../src/temporal/relay.js";
import { scriptedPi, tool } from "./scripted-pi.js";

it("runs dynamic roles, a third worker claim, peer review and final-checkpoint cleanup through real Pi/HTTP/MongoDB/Temporal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atoi-orchestration-"));
  const database = await MongoMemoryReplSet.create({
    binary: { version: "8.2.3" },
    replSet: { count: 1 },
  });
  const mongo = new MongoClient(database.getUri());
  await mongo.connect();
  const temporal = await TestWorkflowEnvironment.createLocal();
  const secret = "orchestration-harness-agent-secret-at-least-32";
  const store = new MongoStore(mongo, mongo.db("orchestration_harness"), secret);
  await store.initialize();
  const api = createServer(store, {
    agentSecret: secret,
    operatorToken: "orchestration-harness-operator-token-at-least-32",
  });
  const backendUrl = await api.listen({ host: "127.0.0.1", port: 0 });
  const { run } = await store.createRun(
    runInput.parse({
      requestId: randomUUID(),
      objective: "Complete an independently reviewed fixture",
      repositoryUrl: "https://github.com/octocat/Hello-World.git",
      workerLimit: 3,
    }),
  );
  const commit = "c".repeat(40); // Synthetic Git evidence; this test does not claim a remote push.
  const stopped = new Set<string>();
  const results = new Map<string, WorkerResult>();
  let publishFinal!: () => void;
  const finalPublication = new Promise<void>((resolve) => {
    publishFinal = resolve;
  });
  const taskQueue = `orchestration-${randomUUID()}`;
  const sandbox = {
    async create(agent: Agent) {
      await mkdir(path.join(root, agent._id), { recursive: true });
      return agent._id;
    },
    async invoke(sandboxId: string, request: WorkerRequest) {
      const task = await store.tasks.findOne({ runId: run._id });
      const peers = await store.agents.find({ runId: run._id }).toArray();
      const reviewer = peers.find((a) => a.role === "verifier");
      const builder = peers.find((a) => a.role === "builder");
      const finishing = request.kind === "orchestrator" && task?.status === "done";
      const turns =
        request.kind === "orchestrator"
          ? !request.checkpoint
            ? [
                [
                  tool("task", "create_task", {
                    title: "Bounded fixture",
                    description: "Exercise a reviewed handoff",
                    acceptanceCriteria: ["Record an independent exact-commit review"],
                  }),
                ],
                [
                  tool("inspector", "spawn_agent", {
                    role: "navigator",
                    instructions: "Discover peers and report to the operator",
                  }),
                ],
                [
                  tool("reviewer", "spawn_agent", {
                    role: "verifier",
                    instructions: "Independently review the builder",
                  }),
                ],
                [
                  tool("third", "spawn_agent", {
                    role: "builder",
                    instructions: "Claim and implement the open task",
                  }),
                ],
                [
                  tool("timer", "schedule_wakeup", {
                    delaySeconds: 1,
                    note: "Inspect the handoff",
                  }),
                ],
                "I delegated work and will wait.",
              ]
            : finishing
              ? [
                  [tool("inspect", "list_tasks", {})],
                  [
                    tool("finish", "finish_run", {
                      finalCommit: commit,
                      outcome: "Scripted model and synthetic Git fixture reviewed",
                    }),
                  ],
                  "Final checkpoint ready.",
                ]
              : [[tool("inspect", "list_tasks", {})], "Waiting for independent review."]
          : request.role === "builder"
            ? [
                [tool("discover", "list_agents", {})],
                [tool("claim", "claim_task", { taskId: task!._id })],
                [
                  tool("file", "write", {
                    path: "verification.txt",
                    content: "Fixture implementation checked",
                  }),
                ],
                [
                  tool("submit", "update_task", {
                    taskId: task!._id,
                    expectedVersion: task!.version + 1,
                    status: "in_review",
                    reviewerId: reviewer!._id,
                    result: {
                      commit,
                      summary: "Synthetic fixture implementation",
                      verification: "Scripted test evidence",
                    },
                  }),
                ],
                [
                  tool("dm", "send_message", {
                    recipientId: reviewer!._id,
                    body: `Review task ${task!._id} at ${commit}`,
                  }),
                ],
                "Submitted; awaiting peer review.",
              ]
            : request.role === "verifier" && task?.status === "in_review"
              ? [
                  [tool("verify", "bash", { command: "printf 'FIXTURE_VERIFICATION_PASSED\\n'" })],
                  [
                    tool("approve", "update_task", {
                      taskId: task._id,
                      expectedVersion: task.version,
                      status: "done",
                      review: {
                        commit,
                        verification: "FIXTURE_VERIFICATION_PASSED; synthetic commit fixture",
                      },
                    }),
                  ],
                  [
                    tool("reply", "send_message", {
                      recipientId: builder!._id,
                      body: "Fixture approved",
                    }),
                  ],
                  "Independent fixture review recorded.",
                ]
              : request.role === "navigator"
                ? [
                    [tool("discover", "list_agents", {})],
                    [
                      tool("operator", "send_message", {
                        recipientId: "operator",
                        body: "The dynamic team is available",
                      }),
                    ],
                    "I reported to the operator.",
                  ]
                : ["Waiting for a review DM."];
      // The builder must not resubmit on its approval follow-up.
      const chosen =
        request.role === "builder" && task?.status === "done"
          ? ["Approval received; available for follow-up."]
          : turns;
      const result = await executeTurn(request, {
        workspace: path.join(root, sandboxId),
        stateDirectory: path.join(root, sandboxId, ".state"),
        configureSession: (session) => scriptedPi(session, chosen),
      });
      results.set(request.invocationId, result);
      if (finishing) await finalPublication;
      return result;
    },
    async confirmedResult(_sandboxId: string, id: string) {
      return results.get(id) ?? null;
    },
    async stop(id: string) {
      stopped.add(id);
    },
    async stopNamed(id: string) {
      stopped.add(id);
    },
  };
  const worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
    activities: createActivities(store, sandbox, {
      BACKEND_PUBLIC_URL: backendUrl,
      AGENT_TOKEN_SECRET: secret,
      PI_PROVIDER: "openai",
      PI_MODEL: "gpt-4.1",
      TURN_TIMEOUT_MS: 10000,
      TURN_MODEL_REQUESTS: 12,
      TURN_TOOL_CALLS: 16,
    }),
  });
  const running = worker.run();
  async function until(predicate: () => Promise<boolean>) {
    const deadline = Date.now() + 20000;
    while (!(await predicate())) {
      if (Date.now() > deadline)
        throw new Error(
          `Orchestration fixture failed to converge: ${JSON.stringify(await store.getRun(run._id))}`,
        );
      await reconcile(store, temporal.client, taskQueue);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await until(async () => (await store.getRun(run._id)).status === "completing");
    expect(stopped.size).toBe(0);
    expect((await store.getRun(run._id)).completion?.status).toBe("pending");
    const task = (await store.tasks.findOne({ runId: run._id }))!;
    const builder = (await store.agents.findOne({ _id: task.ownerId! }))!;
    expect(builder.role).toBe("builder");
    expect(task.status).toBe("done");
    expect(await store.agents.countDocuments({ runId: run._id })).toBe(4);
    expect(await store.deliveries.countDocuments({ recipientId: "operator" })).toBe(0);
    publishFinal();
    await until(async () => (await store.getRun(run._id)).status === "completed");
    expect(stopped.size).toBe(4);
    const finalEvent = (await store.events.findOne({
      runId: run._id,
      actorId: run.orchestratorId!,
      kind: "invocation_finished",
      "details.invocationId": (await store.getRun(run._id)).completion!.invocationId,
    }))!;
    const cleanupEvents = await store.events
      .find({ runId: run._id, kind: "agent_stopped" })
      .toArray();
    expect(cleanupEvents.every((e) => e.sequence > finalEvent.sequence)).toBe(true);
    expect(await store.events.countDocuments({ runId: run._id, kind: "run.finished" })).toBe(1);
    expect(await store.checkpoint(await store.getAgent(run.orchestratorId!))).toContain(
      "Final checkpoint ready",
    );
  } finally {
    publishFinal();
    worker.shutdown();
    await running;
    await api.close();
    await temporal.teardown();
    await mongo.close();
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
