import { timingSafeEqual } from "node:crypto";
import type { Static } from "@sinclair/typebox";
import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { HarnessError } from "./contracts/runtime.js";
import { type Actor, Problem } from "./model.js";
import * as S from "./schemas.js";
import { type CoordinationStore, hash } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export function buildApp(store: CoordinationStore, adminToken: string, logging = false) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(adminToken))
    throw new Error("ADMIN_TOKEN must contain at least 32 and at most 256 URL-safe characters");
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: logging ? { redact: ["req.headers.authorization", "req.body.token"] } : false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.decorateRequest("actor", null);
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: "invalid_input",
        message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    if (error instanceof HarnessError)
      return reply.code(error.statusCode).send({ error: "harness_error", message: error.message });
    if (error instanceof Problem)
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    if (error.validation)
      return reply.code(400).send({
        error: "invalid_input",
        message: "Request does not match the API schema",
        issues: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
      return reply
        .code(error.statusCode)
        .send({ error: "invalid_request", message: "Request could not be accepted" });
    // Database errors can contain connection details and document values.
    request.log.error({ errorType: error.name }, "Coordination request failed");
    return reply.code(500).send({
      error: "internal_error",
      message: "Operation failed; retry using the same request ID where supported",
    });
  });
  app.addHook("preHandler", async (request) => {
    if (request.routeOptions.url === "/health") return;
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.authorization ?? "");
    const token = match?.[1];
    if (!token) throw new Problem(401, "unauthorized", "Bearer credentials are required");
    if (request.routeOptions.url?.match(/^\/(admin|operator)\//)) {
      if (!timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(adminToken))))
        throw new Problem(401, "unauthorized", "Operator credentials are required");
    } else {
      const { runId } = request.params as { runId: string };
      const invocationId = request.headers["x-invocation-id"];
      const generation = Number(request.headers["x-agent-generation"]);
      request.actor = await store.authenticate(
        token,
        runId,
        typeof invocationId === "string" && Number.isInteger(generation) && generation > 0
          ? { id: invocationId, generation }
          : undefined,
      );
    }
  });
  const actor = (value: Actor | null) => {
    if (!value) throw new Problem(401, "unauthorized", "Agent credentials are required");
    return value;
  };
  const page = <T extends { _id: string }>(items: T[], limit: number) => ({
    items,
    nextCursor: items.length === limit ? items.at(-1)?._id : null,
  });
  app.get("/health", async () => ({ status: "ok", mode: "coordination-only" }));
  app.put<{ Params: Static<typeof S.PathRun>; Body: S.NewRun }>(
    "/admin/runs/:runId",
    { schema: { params: S.PathRun, body: S.RunInput } },
    (request) => store.putRun(request.params.runId, request.body),
  );
  app.put<{ Params: Static<typeof S.PathAgent>; Body: S.NewAgent }>(
    "/admin/runs/:runId/agents/:agentId",
    { schema: { params: S.PathAgent, body: S.AgentInput } },
    (request) => store.putAgent(request.params.runId, request.params.agentId, request.body),
  );
  app.get<{ Params: Static<typeof S.PathRun>; Querystring: Static<typeof S.Page> }>(
    "/runs/:runId/agents",
    { schema: { params: S.PathRun, querystring: S.Page } },
    async (request) =>
      page(
        await store.listAgents(actor(request.actor), request.query.after, request.query.limit),
        request.query.limit,
      ),
  );
  app.post<{ Params: Static<typeof S.PathRun>; Body: S.NewTask }>(
    "/runs/:runId/tasks",
    { schema: { params: S.PathRun, body: S.TaskInput } },
    (request) => store.createTask(actor(request.actor), request.body),
  );
  app.get<{ Params: Static<typeof S.PathRun>; Querystring: Static<typeof S.Page> }>(
    "/runs/:runId/tasks",
    { schema: { params: S.PathRun, querystring: S.Page } },
    async (request) =>
      page(
        await store.listTasks(actor(request.actor), request.query.after, request.query.limit),
        request.query.limit,
      ),
  );
  app.post<{ Params: Static<typeof S.PathTask> }>(
    "/runs/:runId/tasks/:taskId/claim",
    { schema: { params: S.PathTask } },
    (request) => store.claimTask(actor(request.actor), request.params.taskId),
  );
  app.patch<{ Params: Static<typeof S.PathTask>; Body: S.UpdateTask }>(
    "/runs/:runId/tasks/:taskId",
    { schema: { params: S.PathTask, body: S.TaskUpdate } },
    (request) => store.updateTask(actor(request.actor), request.params.taskId, request.body),
  );
  app.get<{ Params: Static<typeof S.PathRun>; Querystring: Static<typeof S.Page> }>(
    "/runs/:runId/channels",
    { schema: { params: S.PathRun, querystring: S.Page } },
    async (request) =>
      page(
        await store.listChannels(actor(request.actor), request.query.after, request.query.limit),
        request.query.limit,
      ),
  );
  app.post<{ Params: Static<typeof S.PathRun>; Body: Static<typeof S.DmInput> }>(
    "/runs/:runId/channels/dm",
    { schema: { params: S.PathRun, body: S.DmInput } },
    (request) => store.dm(actor(request.actor), request.body.peerId),
  );
  app.post<{ Params: Static<typeof S.PathChannel>; Body: S.NewMessage }>(
    "/runs/:runId/channels/:channelId/messages",
    { schema: { params: S.PathChannel, body: S.MessageInput } },
    (request) => store.sendMessage(actor(request.actor), request.params.channelId, request.body),
  );
  app.get<{ Params: Static<typeof S.PathChannel>; Querystring: Static<typeof S.MessagePage> }>(
    "/runs/:runId/channels/:channelId/messages",
    { schema: { params: S.PathChannel, querystring: S.MessagePage } },
    async (request) => {
      const items = await store.readChannel(
        actor(request.actor),
        request.params.channelId,
        request.query.after,
        request.query.limit,
      );
      return { items, nextAfter: items.at(-1)?.sequence ?? request.query.after };
    },
  );
  app.get<{ Params: Static<typeof S.PathRun>; Querystring: Static<typeof S.Page> }>(
    "/runs/:runId/inbox",
    { schema: { params: S.PathRun, querystring: S.Page } },
    async (request) =>
      page(
        await store.inbox(actor(request.actor), request.query.after, request.query.limit),
        request.query.limit,
      ),
  );
  return app;
}
