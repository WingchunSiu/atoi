import { randomUUID } from "node:crypto";
import { sha256 } from "../src/agent/runtime.js";
import { runInput, type WorkerResult } from "../src/contracts/runtime.js";
import type { MongoStore } from "../src/store/mongo.js";

export function fixtureResult(invocationId: string, generation: number): WorkerResult {
  const checkpoint =
    '{"type":"session","version":3,"id":"test","cwd":"/workspace/repo","timestamp":"2026-10-11T00:00:00Z"}\n';
  return {
    invocationId,
    generation,
    outcome: "completed",
    text: "Checkpointed",
    checkpoint,
    checkpointSha256: sha256(checkpoint),
    usage: { input: 1, output: 1, cost: 0, toolCalls: 0, modelRequests: 1, elapsedMs: 10 },
  };
}

// Existing boundary tests prepare workers through the same transactional spawn path.
// The orchestrator's model is scripted in the separate end-to-end harness test.
export async function fixtureTeam(
  store: MongoStore,
  workers: Array<{ role: string; instructions: string }>,
) {
  const {
    run,
    agents: [orchestrator],
  } = await store.createRun(
    runInput.parse({
      requestId: randomUUID(),
      objective: "Exercise the runtime boundary",
      repositoryUrl: "https://github.com/octocat/Hello-World.git",
      workerLimit: workers.length,
    }),
  );
  const invocation = (await store.beginInvocation(orchestrator!._id))!;
  const actor = {
    runId: run._id,
    agentId: orchestrator!._id,
    invocationId: invocation._id,
    generation: invocation.generation,
  };
  const agents = [];
  for (const [i, worker] of workers.entries())
    agents.push(await store.spawnAgent(actor, { requestId: `worker_${i}`, ...worker }));
  await store.complete(orchestrator!._id, fixtureResult(invocation._id, invocation.generation));
  // These tests exercise worker boundaries; model-driven orchestration has its own harness test.
  await store.agents.updateOne({ _id: orchestrator!._id }, { $set: { runtimeEnabled: false } });
  await store.outbox.updateMany(
    { runId: run._id, recipientId: orchestrator!._id },
    { $set: { status: "sent" } },
  );
  return {
    run: await store.getRun(run._id),
    agents,
    orchestrator: orchestrator!,
    allAgents: [orchestrator!, ...agents],
  };
}
