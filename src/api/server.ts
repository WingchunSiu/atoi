import { z } from "zod";
import { buildApp } from "../app.js";
import {
  eventInput,
  HarnessError,
  id,
  runInput,
  sendInput,
  workLogInput,
} from "../contracts/runtime.js";
import type { MongoStore } from "../store/mongo.js";
import { activityRoutes } from "./activity.js";

export function createServer(
  store: MongoStore,
  secrets: { operatorToken: string; agentSecret: string },
) {
  const app = buildApp(store, secrets.operatorToken);
  app.register(
    async (operator) => {
      activityRoutes(operator, store);
    },
    { prefix: "/operator" },
  );
  app.post("/operator/runs", async (request) => store.createRun(runInput.parse(request.body)));
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
