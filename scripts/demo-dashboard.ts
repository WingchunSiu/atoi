import { createHash } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { createServer } from "../src/api/server.js";
import type { RunInput, WorkerResult } from "../src/contracts/runtime.js";
import type { Actor } from "../src/model.js";
import { MongoStore } from "../src/store/mongo.js";

// Explicit offline demo: real HTTP/Atlas-compatible persistence, simulated agents,
// evidence and sandboxes. No Temporal, Pi, model provider or Git execution.
class DemoStore extends MongoStore {
  override async createRun(input: RunInput) {
    const result = await super.createRun(input);
    await this.runs.updateOne({ _id: result.run._id }, { $set: { mock: true } });
    return result;
  }
}
const database = await MongoMemoryReplSet.create({
  binary: { version: "8.2.3" },
  replSet: { count: 1 },
});
const mongo = await new MongoClient(database.getUri()).connect();
const token = "local-demo-only-operator-token-00000000";
const secret = "local-demo-only-agent-secret-0000000000";
const store = new DemoStore(mongo, mongo.db("atoi_dashboard_demo"), secret);
await store.initialize();
const app = createServer(store, { operatorToken: token, agentSecret: secret });
await app.listen({ host: "127.0.0.1", port: Number(process.env.DEMO_API_PORT ?? 3000) });
console.log(`Simulated dashboard API on http://127.0.0.1:${process.env.DEMO_API_PORT ?? 3000}`);
console.log(`Local demo token: ${token}`);
console.log(
  "Start the dashboard separately, then launch any HTTPS fixture URL. All agent activity is simulated.",
);
const checkpoint =
  '{"type":"session","version":3,"id":"demo","cwd":"/fixture","timestamp":"2026-10-11T00:00:00Z"}\n';
function result(actor: Actor): WorkerResult {
  return {
    invocationId: actor.invocationId!,
    generation: actor.generation!,
    outcome: "completed",
    text: "Simulated turn",
    checkpoint,
    checkpointSha256: createHash("sha256").update(checkpoint).digest("hex"),
    usage: { input: 0, output: 0, cost: 0, elapsedMs: 0, toolCalls: 0, modelRequests: 0 },
  };
}
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    for (const run of await store.runs.find({ status: "stopping" }).toArray()) {
      for (const agent of await store.agents.find({ runId: run._id }).toArray())
        await store.confirmCleanup(agent._id);
    }
    for (const agent of await store.agents
      .find({ status: { $in: ["idle", "pending"] } })
      .toArray()) {
      if ((await store.getRun(agent.runId)).status !== "active") continue;
      const turn = await store.beginInvocation(agent._id);
      if (!turn) continue;
      const actor: Actor = {
        runId: agent.runId,
        agentId: agent._id,
        invocationId: turn._id,
        generation: turn.generation,
      };
      if (agent.kind === "orchestrator" && !(await store.tasks.findOne({ runId: agent.runId }))) {
        await store.spawn(actor, {
          requestId: "implementer",
          role: "implementer",
          instructions: "Simulated implementation",
        });
        const run = await store.getRun(agent.runId);
        if (run.workerLimit >= 2)
          await store.spawn(actor, {
            requestId: "reviewer",
            role: "reviewer",
            instructions: "Simulated independent review",
          });
        await store.createTask(actor, {
          requestId: "demo-task",
          title: "Simulated parser review",
          description:
            "This local demo validates browser and API wiring. No code or model has executed.",
          acceptanceCriteria: ["Inspect durable task, message and lifecycle events"],
          dependencies: [],
        });
      }
      const dm = await store.dm(actor, "operator");
      await store.sendMessage(actor, dm._id, {
        requestId: `reply_${turn._id}`,
        body:
          agent.kind === "orchestrator"
            ? "Simulated reply: the team is available. This message was persisted through the authenticated backend. No real model or Git work has run."
            : `Simulated ${agent.role} is ready.`,
        mentions: [],
      });
      await store.complete(agent._id, result(actor));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Demo failed");
  } finally {
    busy = false;
  }
}, 1000);
async function close() {
  clearInterval(timer);
  while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
  await app.close();
  await mongo.close();
  await database.stop();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
