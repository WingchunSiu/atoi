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
import type { WorkerRequest, WorkerResult } from "../src/contracts/runtime.js";
import { type Agent, MongoStore } from "../src/store/mongo.js";
import { createActivities } from "../src/temporal/activities.js";
import { reconcile } from "../src/temporal/relay.js";
import { scriptedPi, tool } from "./scripted-pi.js";

it("routes a real Pi peer exchange through the API, MongoDB inbox/outbox and Temporal, with a fixture sandbox/model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atoi-harness-test-"));
  const database = await MongoMemoryReplSet.create({
    binary: { version: "8.0.15" },
    replSet: { count: 1 },
  });
  const mongo = new MongoClient(database.getUri());
  const temporal = await TestWorkflowEnvironment.createLocal();
  await mongo.connect();
  const store = new MongoStore(
    mongo,
    mongo.db("atoi_harness_test"),
    "fixture-agent-secret-32-characters-minimum",
  );
  await store.initialize();
  const secret = "fixture-agent-secret-32-characters-minimum";
  const operatorToken = "fixture-operator-token-32-characters-minimum";
  const api = createServer(store, { agentSecret: secret, operatorToken });
  const backendUrl = await api.listen({ host: "127.0.0.1", port: 0 });
  const headers = { authorization: `Bearer ${operatorToken}` };
  const start = await api.inject({
    method: "POST",
    url: "/operator/runs",
    headers,
    payload: {
      requestId: randomUUID(),
      objective: "Consult the reviewer about parser evidence.",
      repositoryUrl: "https://github.com/octocat/Hello-World.git",
      workerLimit: 2,
    },
  });
  expect(start.statusCode).toBe(200);
  const { run, agents } = start.json() as {
    run: { _id: string };
    agents: Agent[];
  };
  expect(agents).toHaveLength(1);
  expect(agents[0]!.kind).toBe("orchestrator");
  let implementer!: Agent;
  let reviewer!: Agent;
  const results = new Map<string, WorkerResult>();
  const observedRestores: string[] = [];
  const stopped = new Set<string>();
  const sandboxFixture = {
    async create(agent: Agent) {
      await mkdir(path.join(root, agent._id), { recursive: true });
      return agent._id;
    },
    async invoke(sandboxId: string, request: WorkerRequest) {
      implementer = (await store.agents.findOne({ runId: run._id, role: "implementer" }))!;
      reviewer = (await store.agents.findOne({ runId: run._id, role: "reviewer" }))!;
      const isReply =
        request.agentId === implementer?._id && request.prompt.includes("Confirmed: violet-raven");
      const isQuestion =
        request.agentId === reviewer?._id && request.prompt.includes("Please check violet-raven");
      const turns =
        request.kind === "orchestrator"
          ? [
              [
                tool("spawn-implementer", "spawn_agent", {
                  role: "implementer",
                  instructions: "Consult your reviewer.",
                }),
              ],
              [
                tool("spawn-reviewer", "spawn_agent", {
                  role: "reviewer",
                  instructions: "Reply with evidence.",
                }),
              ],
              "Workers assigned; waiting for their messages.",
            ]
          : request.role === "implementer" && !reviewer
            ? [
                [
                  tool("wait-for-peer", "schedule_wakeup", {
                    delaySeconds: 1,
                    note: "Discover the reviewer and consult it",
                  }),
                ],
                "Waiting for peer admission.",
              ]
            : isReply
              ? [
                  [tool("read-evidence", "read", { path: "evidence.txt" })],
                  "I reused the prior evidence and the peer response.",
                ]
              : isQuestion
                ? [
                    [
                      tool("reply", "send_message", {
                        recipientId: implementer._id,
                        body: "Confirmed: violet-raven is supported by the fixture evidence.",
                      }),
                    ],
                    "I sent the evidence-backed reply.",
                  ]
                : request.agentId === implementer?._id
                  ? [
                      [
                        tool("save-evidence", "write", {
                          path: "evidence.txt",
                          content: "violet-raven",
                        }),
                      ],
                      [
                        tool("question", "send_message", {
                          recipientId: reviewer._id,
                          body: "Please check violet-raven against your evidence.",
                        }),
                      ],
                      "I saved violet-raven and asked the reviewer.",
                    ]
                  : ["Ready to review peer evidence."];
      const result = await executeTurn(request, {
        workspace: path.join(root, sandboxId),
        stateDirectory: path.join(root, sandboxId, ".state"),
        async configureSession(session) {
          await scriptedPi(session, turns, (context) => {
            if (isReply && context.includes("I saved violet-raven"))
              observedRestores.push(request.agentId);
          });
        },
      });
      results.set(request.invocationId, result);
      return result;
    },
    async confirmedResult(_sandboxId: string, invocationId: string) {
      return results.get(invocationId) ?? null;
    },
    async stop(sandboxId: string) {
      stopped.add(sandboxId);
    },
    async stopNamed(agentId: string) {
      stopped.add(agentId);
    },
  };
  const taskQueue = "harness-integration-fixture";
  const worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
    activities: createActivities(store, sandboxFixture, {
      BACKEND_PUBLIC_URL: backendUrl,
      AGENT_TOKEN_SECRET: secret,
      PI_PROVIDER: "openai",
      PI_MODEL: "gpt-4.1",
      TURN_TIMEOUT_MS: 10000,
      TURN_MODEL_REQUESTS: 8,
      TURN_TOOL_CALLS: 8,
    }),
  });
  const workerRun = worker.run();
  async function waitUntil(predicate: () => Promise<boolean>) {
    const deadline = Date.now() + 20000;
    while (!(await predicate())) {
      if (Date.now() > deadline)
        throw new Error(
          `Harness fixture did not converge: ${JSON.stringify(await store.agents.find({ runId: run._id }).toArray())}`,
        );
      await reconcile(store, temporal.client, taskQueue);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await waitUntil(
      async () =>
        !!implementer &&
        observedRestores.length > 0 &&
        (await store.getAgent(implementer._id)).status === "idle",
    );
    expect(await store.messages.countDocuments({ runId: run._id })).toBeGreaterThanOrEqual(5);
    expect((await store.getAgent(implementer._id)).turns).toBeGreaterThanOrEqual(2);
    expect(
      await store.deliveries.countDocuments({
        recipientId: implementer._id,
        status: "completed",
      }),
    ).toBeGreaterThanOrEqual(2);
    expect(
      await store.events.countDocuments({
        runId: run._id,
        kind: "tool_execution_end",
      }),
    ).toBeGreaterThanOrEqual(4);
    const stop = await api.inject({
      method: "POST",
      url: `/operator/runs/${run._id}/stop`,
      headers,
      payload: {},
    });
    expect(stop.statusCode).toBe(200);
    await waitUntil(async () => (await store.getRun(run._id)).status === "stopped");
    expect(stopped).toEqual(
      new Set((await store.agents.find({ runId: run._id }).toArray()).map((agent) => agent._id)),
    );
  } finally {
    worker.shutdown();
    await workerRun;
    await api.close();
    await temporal.teardown();
    await mongo.close();
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
