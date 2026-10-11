import { z } from "zod";
import { buildApp } from "../app.js";
import {
  eventInput,
  finishInput,
  HarnessError,
  id,
  recoveryInput,
  runInput,
  sendInput,
  spawnInput,
  workLogInput,
} from "../contracts/runtime.js";
import { repositorySecret } from "../repositories.js";
import type { MongoStore } from "../store/mongo.js";
import { activityRoutes } from "./activity.js";
import { dashboardRoutes } from "./dashboard.js";

export function createServer(
  store: MongoStore,
  secrets: { operatorToken: string; agentSecret: string },
  repositorySecrets?: Record<string, string>,
) {
  const app = buildApp(store, secrets.operatorToken);
  dashboardRoutes(app, store);
  app.register(
    async (operator) => {
      activityRoutes(operator, store);
    },
    { prefix: "/operator" },
  );
  app.get("/operator/repositories", async () => ({
    repositories: Object.keys(repositorySecrets ?? {}).map((name) => ({
      name,
      url: `https://github.com/${name}.git`,
    })),
    restricted: repositorySecrets !== undefined,
  }));
  app.post("/operator/runs", async (request) => {
    const input = runInput.parse(request.body);
    if (repositorySecrets) repositorySecret(input.repositoryUrl, repositorySecrets);
    return store.createRun(input);
  });
  app.get("/operator/runs/:runId", async (request) => {
    const { runId } = z.object({ runId: id }).parse(request.params);
    const agents = await store.agents.find({ runId }, { projection: { tokenHash: 0 } }).toArray();
    return {
      run: await store.getRun(runId),
      agents,
      tasks: await store.tasks.find({ runId }).limit(100).toArray(),
      messages: await store.messages.find({ runId }).sort({ createdAt: -1 }).limit(100).toArray(),
      events: await store.events.find({ runId }).sort({ createdAt: -1 }).limit(100).toArray(),
      invocations: await store.invocations
        .find({ agentId: { $in: agents.map((a) => a._id) } })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray(),
      pendingOutbox: await store.outbox.find({ runId, status: "pending" }).limit(100).toArray(),
    };
  });
  app.post("/operator/runs/:runId/messages", async (request) => {
    const { runId } = z.object({ runId: id }).parse(request.params);
    return store.send(runId, "operator", sendInput.parse(request.body));
  });
  app.post("/operator/runs/:runId/stop", async (request) => {
    const { runId } = z.object({ runId: id }).parse(request.params);
    await store.stopRun(runId);
    return { status: "stopping", runId };
  });
  app.post("/operator/runs/:runId/agents/:agentId/replace", async (request) => {
    const { runId, agentId } = z.object({ runId: id, agentId: id }).parse(request.params);
    return store.requestRecovery(runId, agentId, recoveryInput.parse(request.body));
  });
  app.post("/runs/:runId/spawn", async (request) => {
    if (!request.actor) throw new HarnessError(401, "Agent authentication required");
    return store.spawn(request.actor, spawnInput.parse(request.body));
  });
  app.post("/runs/:runId/complete-objective", async (request) => {
    if (!request.actor) throw new HarnessError(401, "Agent authentication required");
    return store.completeObjective(request.actor, finishInput.parse(request.body));
  });
  app.post("/runs/:runId/events", { bodyLimit: 132 * 1024 }, async (request) => {
    if (!request.actor) throw new HarnessError(401, "Agent authentication required");
    await store.recordEvent(request.actor, eventInput.parse(request.body));
    return { accepted: true };
  });
  app.post("/runs/:runId/logs", async (request) => {
    if (!request.actor) throw new HarnessError(401, "Agent authentication required");
    const { requestId, sessionId, ...payload } = workLogInput.parse(request.body);
    await store.recordEvent(request.actor, {
      requestId,
      sessionId,
      type: "work_log",
      payload: { ...payload, source: "agent_reported" },
    });
    return { recorded: true };
  });
  return app;
}
