import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { createServer as createViteServer } from "vite";
import { sha256 } from "../src/agent/runtime.js";
import { createServer } from "../src/api/server.js";
import { runInput } from "../src/contracts/runtime.js";
import { MongoStore } from "../src/store/mongo.js";

// Explicit offline fixture. No inference, Temporal workflows or Modal resources.
const database = await MongoMemoryReplSet.create({
  binary: { version: "8.0.15" },
  replSet: { count: 1 },
});
const client = new MongoClient(database.getUri());
await client.connect();
const store = new MongoStore(
  client,
  client.db("atoi_activity_demo"),
  "offline-demo-agent-secret-32-characters",
);
await store.initialize();
const api = createServer(store, {
  operatorToken: "offline-demo-operator-token-32-characters",
  agentSecret: "offline-demo-agent-secret-32-characters",
});
const vite = await createViteServer({
  root: "web",
  configFile: "web/vite.config.ts",
  server: {
    port: 5174,
    strictPort: true,
    proxy: { "/operator": "http://127.0.0.1:3100" },
  },
});
let stopped = false;
try {
  await api.listen({ host: "127.0.0.1", port: 3100 });
  await vite.listen();
  const { run, agents } = await store.createRun(
    runInput.parse({
      requestId: randomUUID(),
      objective: "Offline demo: fix the empty-input parser case and review the change",
      repositoryUrl: "https://github.com/octocat/Hello-World.git",
      agents: [
        { role: "implementer", instructions: "Scripted demo" },
        { role: "reviewer", instructions: "Scripted demo" },
      ],
    }),
  );
  const implementer = agents[0]!;
  console.log("Scripted offline activity demo: http://127.0.0.1:5174/?demo=1");
  const close = async () => {
    if (stopped) return;
    stopped = true;
    await vite.close();
    await api.close();
    await client.close();
    await database.stop();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  let turn = 0;
  while (!stopped) {
    const agent = agents[turn % agents.length]!;
    if (turn >= agents.length)
      await store.send(run._id, "operator", {
        requestId: `followup-${turn}`,
        recipientId: agent._id,
        body: "Continue the scripted demonstration.",
        mentions: [],
      });
    const invocation = await store.beginInvocation(agent._id);
    if (!invocation) {
      console.log(
        "Scripted demo reached its turn limit. History remains available until you stop the process.",
      );
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      break;
    }
    const current = await store.getAgent(agent._id);
    if (turn === 0) {
      const actor = {
        runId: run._id,
        agentId: implementer._id,
        invocationId: invocation._id,
        generation: invocation.generation,
      };
      const task = await store.createTask(actor, {
        requestId: "offline-fixture-task",
        title: "Inspect the empty-input parser case",
        description: "Scripted fixture task; no repository changes or verified result.",
        acceptanceCriteria: ["Record actual parser test evidence in a real run"],
        dependencies: [],
      });
      await store.claimTask(actor, task._id);
    }
    const add = async (type: string, payload: unknown) => {
      if (stopped) return;
      await store.mutateInvocation(
        agent._id,
        invocation._id,
        invocation.generation,
        (active, session) =>
          store.recordInvocationEvent(
            active,
            invocation._id,
            {
              requestId: randomUUID(),
              sessionId: "offline-demo-session",
              type,
              payload,
            },
            session,
          ),
      );
    };
    const toolCallId = `test-${turn}`;
    await add("tool_execution_start", {
      toolCallId,
      toolName: "bash",
      args: { command: "npm test -- parser" },
    });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await add("tool_execution_end", {
      toolCallId,
      toolName: "bash",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Scripted fixture output: 3 parser tests passed.",
          },
        ],
      },
    });
    await add("work_log", {
      note:
        agent.role === "implementer"
          ? "Added an empty-input guard and regression coverage in this scripted example."
          : "Reviewed the advertised change in this scripted example.",
      nextStep: "Inspect the exact commit and record independent test results.",
      evidence: ["Scripted fixture output; this is not actual verification."],
      source: "agent_reported",
    });
    await add("message_end", {
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The scripted checks finished. Ready for the next handoff.",
          },
        ],
      },
    });
    if (stopped) break;
    const checkpoint =
      JSON.stringify({
        type: "session",
        version: 3,
        id: "offline-demo-session",
        cwd: "/fixture",
        timestamp: new Date().toISOString(),
      }) + "\n";
    await store.complete(agent._id, {
      invocationId: invocation._id,
      generation: current.generation,
      outcome: "completed",
      text: "Scripted example finished.",
      checkpoint,
      checkpointSha256: sha256(checkpoint),
      usage: {
        input: 0,
        output: 0,
        cost: 0,
        toolCalls: 1,
        modelRequests: 0,
        elapsedMs: 1800,
      },
    });
    turn++;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
} catch (error) {
  stopped = true;
  await vite.close();
  await api.close();
  await client.close();
  await database.stop();
  throw error;
}
