import { createHash, randomUUID } from "node:crypto";
import { type ClientSession, type Db, type MongoClient } from "mongodb";
import { ORCHESTRATOR_INSTRUCTIONS } from "../agent/prompts.js";
import { agentToken } from "../api/auth.js";
import {
  type FinishInput,
  HarnessError,
  type RunInput,
  type SendInput,
  type SpawnInput,
  type WorkerResult,
} from "../contracts/runtime.js";
import type { Actor, Agent, Run } from "../model.js";
import { CoordinationStore, hash as stringHash } from "../store.js";

export type { Agent, Run } from "../model.js";

interface Invocation {
  _id: string;
  agentId: string;
  generation: number;
  status: "running" | "completed" | "uncertain";
  deliveryIds: string[];
  provisioningAttempts: string[];
  prompt: string;
  result?: Omit<WorkerResult, "checkpoint">;
  error?: string;
  createdAt: Date;
}
interface Checkpoint {
  _id: string;
  agentId: string;
  invocationId: string;
  sha256: string;
  jsonl: string;
}
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(message: string): never {
  throw new HarnessError(409, message);
}
export class MongoStore extends CoordinationStore {
  constructor(
    client: MongoClient,
    db: Db,
    private readonly agentSecret: string,
    collectionPrefix = "",
  ) {
    super(client, db, collectionPrefix);
  }
  get invocations() {
    return this.db.collection<Invocation>(`${this.collectionPrefix}invocations`);
  }
  get checkpoints() {
    return this.db.collection<Checkpoint>(`${this.collectionPrefix}session_checkpoints`);
  }
  override async initialize() {
    await super.initialize();
    await this.invocations.createIndex({ agentId: 1, createdAt: 1 });
    await this.checkpoints.createIndex({ agentId: 1 });
    await this.wakeups.createIndex({ agentId: 1, status: 1, wakeAt: 1 });
  }
  async getAgent(agentId: string, session?: ClientSession): Promise<Agent> {
    const agent = await this.agents.findOne({ _id: agentId }, { session });
    if (!agent) throw new HarnessError(404, "Agent not found");
    return agent;
  }
  async getRun(runId: string, session?: ClientSession): Promise<Run> {
    const run = await this.runs.findOne({ _id: runId }, { session });
    if (!run) throw new HarnessError(404, "Run not found");
    return run;
  }
  override async event(
    session: ClientSession,
    actor: Actor,
    kind: string,
    entityId: string,
    details: Record<string, unknown> = {},
  ) {
    await super.event(session, actor, kind, entityId, details);
    if (kind !== "task.updated" || !["in_review", "done", "blocked"].includes(String(details.to)))
      return;
    const run = await this.getRun(actor.runId, session);
    if (run.status !== "active" || !run.orchestratorId || actor.agentId === run.orchestratorId)
      return;
    await this.enqueueMessage(
      session,
      run._id,
      "harness",
      run.orchestratorId,
      `Task ${entityId} changed to ${details.to} by ${actor.agentId}. Read list_tasks for authoritative state and evidence.`,
      `task_${entityId}_${details.version}`,
    );
  }
  async assertActive(runId: string, session?: ClientSession): Promise<Run> {
    const run = await this.getRun(runId, session);
    if (run.status !== "active" || run.deadline <= new Date())
      fail("Run is stopped or its deadline has passed");
    return run;
  }
  async assertInvocation(
    agentId: string,
    invocationId: string,
    generation: number,
    session?: ClientSession,
  ): Promise<Agent> {
    const agent = await this.getAgent(agentId, session);
    if (
      agent.status !== "running" ||
      agent.generation !== generation ||
      agent.invocationId !== invocationId
    )
      fail("Stale or inactive agent invocation");
    const run = await this.getRun(agent.runId, session);
    const finishing =
      run.status === "completing" &&
      run.orchestratorId === agentId &&
      run.completion?.invocationId === invocationId &&
      run.completion.generation === generation;
    if ((!finishing && run.status !== "active") || run.deadline <= new Date())
      fail("Run is stopped or its deadline has passed");
    return agent;
  }

  private newAgent(
    runId: string,
    agentId: string,
    kind: Agent["kind"],
    role: string,
    instructions: string,
  ): Agent {
    return {
      _id: agentId,
      runId,
      kind,
      role,
      instructions,
      status: "pending",
      runtimeEnabled: true,
      tokenHash: stringHash(agentToken(this.agentSecret, agentId)),
      generation: 0,
      turns: 0,
      toolEpoch: 0,
      sandboxId: null,
      cleanupCompletedAt: null,
      checkpointId: null,
      invocationId: null,
      createdAt: new Date(),
    };
  }

  private publicAgent({ tokenHash: _secret, ...agent }: Agent) {
    return agent;
  }

  private async queueAction(
    session: ClientSession,
    runId: string,
    recipientId: string,
    kind: "run_start" | "agent_start" | "run_completion",
    key: string,
  ) {
    await this.outbox.updateOne(
      { _id: hash([kind, key]) },
      {
        $setOnInsert: {
          runId,
          recipientId,
          kind,
          status: "pending",
          attempts: 0,
          createdAt: new Date(),
        },
      },
      { session, upsert: true },
    );
  }

  private async seedAgent(session: ClientSession, agent: Agent, senderId: string, body: string) {
    await this.agents.insertOne(agent, { session });
    await this.channels.updateOne(
      { runId: agent.runId, kind: "team" },
      { $addToSet: { participants: agent._id } },
      { session },
    );
    await this.enqueueMessage(
      session,
      agent.runId,
      senderId,
      agent._id,
      body,
      `initial_${agent._id}`,
    );
    await this.queueAction(session, agent.runId, agent._id, "agent_start", agent._id);
    await this.event(
      session,
      { runId: agent.runId, agentId: senderId },
      "agent.spawned",
      agent._id,
      {
        agent: this.publicAgent(agent),
        spawnedBy: senderId,
      },
    );
  }

  // Internal harness notifications share the same durable message/delivery/outbox boundary.
  private async enqueueMessage(
    session: ClientSession,
    runId: string,
    senderId: string,
    recipientId: string,
    body: string,
    requestId: string,
  ) {
    const messageId = hash([runId, senderId, requestId]);
    if (await this.messages.findOne({ _id: messageId }, { session })) return;
    const channel = await this.channels.findOneAndUpdate(
      { runId, kind: "team" },
      { $inc: { nextSequence: 1 } },
      { session, returnDocument: "after" },
    );
    if (!channel) throw new HarnessError(404, "Team channel not found");
    await this.messages.insertOne(
      {
        _id: messageId,
        runId,
        channelId: channel._id,
        senderId,
        requestId,
        fingerprint: hash(body),
        body,
        mentions: [recipientId],
        recipients: [recipientId],
        sequence: channel.nextSequence,
        createdAt: new Date(),
      },
      { session },
    );
    const deliveryId = hash([messageId, recipientId]);
    await this.deliveries.insertOne(
      {
        _id: deliveryId,
        runId,
        channelId: channel._id,
        recipientId,
        messageId,
        sequence: channel.nextSequence,
        status: "pending",
        createdAt: new Date(),
      },
      { session },
    );
    await this.outbox.insertOne(
      {
        _id: deliveryId,
        runId,
        recipientId,
        deliveryId,
        kind: "mailbox_wakeup",
        status: "pending",
        attempts: 0,
        createdAt: new Date(),
      },
      { session },
    );
    await this.event(session, { runId, agentId: senderId }, "message.sent", messageId, {
      channelId: channel._id,
      recipientIds: [recipientId],
    });
  }

  async createRun(input: RunInput) {
    const runId = hash(["run", input.requestId]);
    return this.transaction(async (session) => {
      const existing = await this.runs.findOne({ _id: runId }, { session });
      const fingerprint = hash(input);
      if (existing) {
        if ((existing as Run & { requestHash: string }).requestHash !== fingerprint)
          fail("Start request ID reused with different input");
        return {
          run: existing,
          agents: await this.agents
            .find({ runId }, { session, projection: { tokenHash: 0 } })
            .toArray(),
        };
      }
      const orchestratorId = hash([runId, "orchestrator"]);
      const run: Run & { requestHash: string } = {
        _id: runId,
        requestHash: fingerprint,
        objective: input.objective,
        ...(input.repositoryUrl ? { repository: input.repositoryUrl } : {}),
        workerLimit: input.workerLimit,
        workerCount: 0,
        orchestratorId,
        status: "active",
        deadline: new Date(Date.now() + input.lifetimeSeconds * 1000),
        maxInvocationsPerAgent: input.maxInvocationsPerAgent,
        createdAt: new Date(),
      };
      await this.runs.insertOne(run, { session });
      await this.channels.insertOne(
        {
          _id: hash([runId, "team"]),
          runId,
          kind: "team",
          participants: ["operator"],
          nextSequence: 0,
          createdAt: new Date(),
        },
        { session },
      );
      const agent = this.newAgent(
        runId,
        orchestratorId,
        "orchestrator",
        "orchestrator",
        ORCHESTRATOR_INSTRUCTIONS,
      );
      await this.seedAgent(session, agent, "operator", input.objective);
      await this.queueAction(session, runId, orchestratorId, "run_start", runId);
      await this.event(session, { runId, agentId: "operator" }, "run.started", runId, {
        objective: run.objective,
        workerLimit: run.workerLimit,
        orchestratorId,
      });
      return { run: await this.getRun(runId, session), agents: [this.publicAgent(agent)] };
    });
  }

  async spawnAgent(actor: Actor, input: SpawnInput) {
    return this.mutateInvocation(
      actor.agentId,
      actor.invocationId!,
      actor.generation!,
      async (agent, session) => {
        const run = await this.assertActive(actor.runId, session);
        if (agent.kind !== "orchestrator" || run.orchestratorId !== agent._id)
          throw new HarnessError(403, "Only the run orchestrator can spawn workers");
        const agentId = hash([run._id, "spawn", input.requestId]);
        const fingerprint = hash(input);
        const prior = await this.agents.findOne({ _id: agentId }, { session });
        if (prior) {
          if (prior.spawnRequestHash !== fingerprint)
            fail("Spawn request ID reused with different input");
          return this.publicAgent(prior);
        }
        const reserved = await this.runs.updateOne(
          { _id: run._id, status: "active", workerCount: { $lt: run.workerLimit } },
          { $inc: { workerCount: 1 } },
          { session },
        );
        if (!reserved.matchedCount) fail("Worker limit reached (including pending workers)");
        const worker = {
          ...this.newAgent(run._id, agentId, "worker", input.role, input.instructions),
          spawnRequestHash: fingerprint,
        };
        await this.seedAgent(
          session,
          worker,
          agent._id,
          `Begin the work assigned by agent ${agent._id}: ${input.instructions}\nUse get_run if you need the overall objective. Discover peers and coordinate through tasks and messages.`,
        );
        return this.publicAgent(worker);
      },
    );
  }

  async requestFinish(actor: Actor, input: FinishInput) {
    return this.mutateInvocation(
      actor.agentId,
      actor.invocationId!,
      actor.generation!,
      async (agent, session) => {
        const run = await this.getRun(actor.runId, session);
        if (agent.kind !== "orchestrator" || run.orchestratorId !== agent._id)
          throw new HarnessError(403, "Only the run orchestrator can finish the run");
        if (run.completion) {
          if (run.completion.fingerprint !== hash(input))
            fail("Completion request conflicts with the accepted result");
          return { status: "completing", finalCommit: run.completion.finalCommit };
        }
        await this.assertActive(run._id, session);
        const tasks = await this.tasks.find({ runId: run._id }, { session }).limit(1001).toArray();
        if (
          tasks.length > 1000 ||
          tasks.some(
            (task) =>
              task.status !== "done" ||
              !task.result ||
              (task.reviewerId &&
                (!task.review ||
                  task.reviewerId === task.ownerId ||
                  task.review.commit !== task.result.commit)),
          )
        )
          fail(
            "All recorded tasks must be done; requested reviews must be resolved before completion",
          );
        if (input.finalCommit && !tasks.some((task) => task.result?.commit === input.finalCommit))
          fail("Final commit must match a recorded task result");
        const completion: NonNullable<Run["completion"]> = {
          ...input,
          fingerprint: hash(input),
          invocationId: actor.invocationId!,
          generation: actor.generation!,
          deadline: new Date(Math.min(run.deadline.getTime(), Date.now() + 12 * 60 * 1000)),
          status: "pending",
        };
        await this.runs.updateOne(
          { _id: run._id, status: "active" },
          { $set: { status: "completing", completion } },
          { session },
        );
        await this.queueAction(
          session,
          run._id,
          agent._id,
          "run_completion",
          `${run._id}:requested`,
        );
        await this.event(session, actor, "run.completion_requested", run._id, {
          finalCommit: input.finalCommit,
          outcome: input.outcome,
          invocationId: actor.invocationId,
        });
        return { status: "completing", finalCommit: input.finalCommit };
      },
    );
  }

  async scheduleWakeup(
    actor: Actor,
    input: { requestId: string; delaySeconds: number; note: string },
  ) {
    return this.mutateInvocation(
      actor.agentId,
      actor.invocationId!,
      actor.generation!,
      async (_agent, session) => {
        const run = await this.assertActive(actor.runId, session);
        const timerId = hash([actor.agentId, input.requestId]);
        const prior = await this.wakeups.findOne({ _id: timerId }, { session });
        if (prior) {
          if (prior.fingerprint !== hash(input))
            fail("Wakeup request ID reused with different input");
          return prior;
        }
        const wakeAt = new Date(Date.now() + input.delaySeconds * 1000);
        if (wakeAt >= run.deadline) fail("Wakeup must be before the run deadline");
        if (
          (await this.wakeups.countDocuments(
            { agentId: actor.agentId, status: "pending" },
            { session },
          )) >= 5
        )
          fail("At most five pending wakeups per agent");
        const timer = {
          _id: timerId,
          runId: actor.runId,
          agentId: actor.agentId,
          fingerprint: hash(input),
          note: input.note,
          wakeAt,
          status: "pending" as const,
        };
        await this.wakeups.insertOne(timer, { session });
        await this.event(session, actor, "agent.wakeup_scheduled", timerId, {
          wakeAt,
          note: input.note,
        });
        return timer;
      },
    );
  }

  get wakeups() {
    return this.db.collection<{
      _id: string;
      runId: string;
      agentId: string;
      fingerprint: string;
      note: string;
      wakeAt: Date;
      status: "pending" | "fired" | "cancelled";
    }>(`${this.collectionPrefix}wakeups`);
  }

  async send(
    runId: string,
    senderId: string,
    input: SendInput,
    invocation?: { id: string; generation: number },
  ) {
    const actor: Actor = {
      runId,
      agentId: senderId,
      ...(invocation ? { invocationId: invocation.id, generation: invocation.generation } : {}),
    };
    let channelId: string;
    if (input.recipientId) channelId = (await this.dm(actor, input.recipientId))._id;
    else channelId = (await this.channels.findOne({ runId, kind: "team" }))!._id;
    return this.sendMessage(actor, channelId, {
      requestId: input.requestId,
      body: input.body,
      mentions: input.mentions,
    });
  }
  async mutateInvocation<T>(
    agentId: string,
    invocationId: string,
    generation: number,
    action: (agent: Agent, session: ClientSession) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (session) => {
      const agent = await this.assertInvocation(agentId, invocationId, generation, session);
      await this.agents.updateOne(
        { _id: agentId, generation },
        { $inc: { toolEpoch: 1 } },
        { session },
      );
      return action(agent, session);
    });
  }

  async recordInvocationEvent(
    agent: Agent,
    invocationId: string,
    input: {
      requestId: string;
      type: string;
      payload: unknown;
      sessionId?: string;
    },
    session?: ClientSession,
  ): Promise<void> {
    if (!session)
      return this.transaction((active) =>
        this.recordInvocationEvent(agent, invocationId, input, active),
      );
    if (Buffer.byteLength(JSON.stringify(input.payload) ?? "null") > 128_000)
      throw new HarnessError(400, "Event payload exceeds the limit");
    const eventId = hash([agent._id, input.requestId]);
    const requestHash = hash([invocationId, agent.generation, input]);
    const prior = await this.events.findOne({ _id: eventId }, { session });
    if (prior) {
      if (prior.requestHash !== requestHash) fail("Event request ID reused with different input");
      return;
    }
    // The counter and event commit together. Concurrent writers cannot publish a
    // lower cursor after a client has already advanced past it.
    const run = await this.runs.findOneAndUpdate(
      { _id: agent.runId },
      { $inc: { eventSequence: 1 } },
      { returnDocument: "after", session },
    );
    if (!run?.eventSequence) throw new HarnessError(404, "Run not found");
    await this.events.insertOne(
      {
        _id: eventId,
        runId: agent.runId,
        actorId: agent._id,
        entityId: invocationId,
        generation: agent.generation,
        sessionId: input.sessionId,
        sequence: run.eventSequence,
        requestHash,
        kind: input.type,
        details: { invocationId, payload: input.payload },
        createdAt: new Date(),
      },
      { session },
    );
  }

  async recordEvent(
    actor: Actor,
    input: { requestId: string; type: string; payload: unknown; sessionId?: string },
  ) {
    await this.mutateInvocation(
      actor.agentId,
      actor.invocationId!,
      actor.generation!,
      (agent, session) => this.recordInvocationEvent(agent, actor.invocationId!, input, session),
    );
  }
  async beginInvocation(
    agentId: string,
    invocationId: string = randomUUID(),
  ): Promise<Invocation | null> {
    return this.transaction(async (session) => {
      const agent = await this.getAgent(agentId, session);
      const run = await this.getRun(agent.runId, session);
      const prior = await this.invocations.findOne({ _id: invocationId, agentId }, { session });
      if (prior) return prior;
      if (run.status !== "active" || run.deadline <= new Date()) return null;
      if (agent.status === "needs_inspection" || agent.status === "stopped") return null;
      if (agent.invocationId)
        return this.invocations.findOne({ _id: agent.invocationId }, { session });
      if (agent.turns >= run.maxInvocationsPerAgent) {
        await this.agents.updateOne(
          { _id: agentId },
          { $set: { status: "needs_inspection" } },
          { session },
        );
        await this.event(session, { agentId, runId: run._id }, "agent.budget_exhausted", agentId, {
          status: "needs_inspection",
          turns: agent.turns,
        });
        if (run.orchestratorId === agentId)
          await this.queueAction(session, run._id, agentId, "run_completion", `budget_${agentId}`);
        else if (run.orchestratorId)
          await this.enqueueMessage(
            session,
            run._id,
            "harness",
            run.orchestratorId,
            `Agent ${agentId} exhausted its invocation budget and needs inspection.`,
            `budget_${agentId}`,
          );
        return null;
      }
      for (const timer of await this.wakeups
        .find({ agentId, status: "pending", wakeAt: { $lte: new Date() } }, { session })
        .toArray()) {
        await this.enqueueMessage(
          session,
          agent.runId,
          "harness",
          agentId,
          `[Scheduled wakeup] ${timer.note}`,
          `timer_${timer._id}`,
        );
        await this.wakeups.updateOne(
          { _id: timer._id, status: "pending" },
          { $set: { status: "fired" } },
          { session },
        );
        await this.event(session, { agentId, runId: agent.runId }, "agent.timer_fired", timer._id);
      }
      const deliveries = await this.deliveries
        .find({ recipientId: agentId, status: "pending" }, { session })
        .sort({ createdAt: 1 })
        .limit(5)
        .toArray();
      if (!deliveries.length) return null;
      const messages = await this.messages
        .find({ _id: { $in: deliveries.map((delivery) => delivery.messageId) } }, { session })
        .toArray();
      const invocation: Invocation = {
        _id: invocationId,
        agentId,
        generation: agent.generation + 1,
        status: "running",
        provisioningAttempts: [],
        deliveryIds: deliveries.map((delivery) => delivery._id),
        prompt: deliveries
          .map((delivery) => {
            const message = messages.find((item) => item._id === delivery.messageId)!;
            return `[Message ${message._id} from ${message.senderId}]\n${message.body}`;
          })
          .join("\n\n"),
        createdAt: new Date(),
      };
      await this.invocations.insertOne(invocation, { session });
      await this.deliveries.updateMany(
        { _id: { $in: invocation.deliveryIds }, status: "pending" },
        {
          $set: {
            status: "processing",
            invocationId: invocation._id,
            generation: invocation.generation,
          },
        },
        { session },
      );
      await this.agents.updateOne(
        { _id: agentId },
        {
          $set: {
            generation: invocation.generation,
            invocationId: invocation._id,
            status: "running",
          },
          $inc: { turns: 1 },
        },
        { session },
      );
      await this.recordInvocationEvent(
        { ...agent, generation: invocation.generation },
        invocation._id,
        {
          requestId: `started_${invocation._id}`,
          type: "invocation_started",
          payload: { status: "running", deliveryIds: invocation.deliveryIds },
        },
        session,
      );
      return invocation;
    });
  }

  async checkpoint(agent: Agent): Promise<string | null> {
    if (!agent.checkpointId) return null;
    const checkpoint = await this.checkpoints.findOne({
      _id: agent.checkpointId,
    });
    if (
      !checkpoint ||
      createHash("sha256").update(checkpoint.jsonl).digest("hex") !== checkpoint.sha256
    )
      fail("Checkpoint missing or failed its content hash");
    return checkpoint.jsonl;
  }

  async complete(agentId: string, result: WorkerResult): Promise<void> {
    if (
      Buffer.byteLength(result.checkpoint) > 6_000_000 ||
      createHash("sha256").update(result.checkpoint).digest("hex") !== result.checkpointSha256
    )
      throw new HarnessError(400, "Checkpoint size or hash is invalid");
    await this.transaction(async (session) => {
      const invocation = await this.invocations.findOne(
        { _id: result.invocationId, agentId },
        { session },
      );
      if (invocation?.status === "completed") {
        if (
          invocation.result?.checkpointSha256 !== result.checkpointSha256 ||
          invocation.generation !== result.generation
        )
          fail("Conflicting invocation result");
        return;
      }
      const agent = await this.assertInvocation(
        agentId,
        result.invocationId,
        result.generation,
        session,
      );
      if (
        !invocation ||
        invocation.generation !== result.generation ||
        invocation.status !== "running"
      )
        fail("Invocation cannot accept a checkpoint");
      await this.checkpoints.insertOne(
        {
          _id: result.invocationId,
          agentId,
          invocationId: result.invocationId,
          sha256: result.checkpointSha256,
          jsonl: result.checkpoint,
        },
        { session },
      );
      const { checkpoint: _checkpoint, ...summary } = result;
      await this.invocations.updateOne(
        { _id: result.invocationId },
        { $set: { status: "completed", result: summary } },
        { session },
      );
      await this.deliveries.updateMany(
        {
          _id: { $in: invocation.deliveryIds },
          invocationId: result.invocationId,
        },
        { $set: { status: "completed" } },
        { session },
      );
      await this.agents.updateOne(
        {
          _id: agentId,
          generation: result.generation,
          invocationId: result.invocationId,
        },
        {
          $set: {
            checkpointId: result.invocationId,
            invocationId: null,
            status: result.outcome === "completed" ? "idle" : "needs_inspection",
          },
        },
        { session },
      );
      await this.recordInvocationEvent(
        agent,
        result.invocationId,
        {
          requestId: `finished_${result.invocationId}`,
          type: "invocation_finished",
          payload: {
            status: result.outcome === "completed" ? "idle" : "needs_inspection",
            outcome: result.outcome,
            usage: result.usage,
            error: result.error,
          },
        },
        session,
      );
      const run = await this.getRun(agent.runId, session);
      if (run.status === "completing" && run.completion?.invocationId === result.invocationId) {
        await this.runs.updateOne(
          { _id: run._id },
          {
            $set: {
              "completion.status": result.outcome === "completed" ? "checkpointed" : "failed",
              ...(result.outcome === "completed"
                ? {}
                : {
                    "completion.error": result.error ?? "Final orchestrator turn did not complete",
                  }),
            },
          },
          { session },
        );
        await this.queueAction(
          session,
          run._id,
          agentId,
          "run_completion",
          `${run._id}:checkpoint`,
        );
      }
    });
  }

  async uncertain(agentId: string, invocationId: string | null, error: string): Promise<void> {
    await this.transaction(async (session) => {
      const agent = await this.getAgent(agentId, session);
      const invocation = invocationId
        ? await this.invocations.findOne({ _id: invocationId, agentId }, { session })
        : null;
      if (invocationId && (!invocation || invocation.status !== "running")) return;
      if (
        !invocationId &&
        (agent.invocationId || agent.status === "needs_inspection" || agent.status === "stopped")
      )
        return;
      if (invocation)
        await this.invocations.updateOne(
          { _id: invocation._id },
          { $set: { status: "uncertain", error: error.slice(0, 4000) } },
          { session },
        );
      const current = agent.invocationId === invocationId && agent.status !== "stopped";
      if (current)
        await this.agents.updateOne(
          { _id: agentId, invocationId, status: { $ne: "stopped" } },
          { $set: { status: "needs_inspection" } },
          { session },
        );
      await this.recordInvocationEvent(
        { ...agent, generation: invocation?.generation ?? agent.generation },
        invocationId ?? "none",
        {
          requestId: `uncertain_${invocationId ?? agent.generation}`,
          type: invocation ? "invocation_uncertain" : "agent_failed",
          payload: {
            ...(current ? { status: "needs_inspection" } : {}),
            error: error.slice(0, 4000),
          },
        },
        session,
      );
      const run = await this.getRun(agent.runId, session);
      if (current && ["active", "completing"].includes(run.status) && run.orchestratorId) {
        if (agentId === run.orchestratorId)
          await this.queueAction(
            session,
            run._id,
            agentId,
            "run_completion",
            `failed_${invocationId ?? agent.generation}`,
          );
        else if (run.status === "active")
          await this.enqueueMessage(
            session,
            run._id,
            "harness",
            run.orchestratorId,
            `Agent ${agentId} needs inspection: ${error.slice(0, 4000)}`,
            `failed_${agentId}_${invocationId ?? agent.generation}`,
          );
      }
    });
  }

  async beginProvisioning(
    agentId: string,
    invocationId: string,
    generation: number,
  ): Promise<string> {
    const attemptId = randomUUID();
    await this.mutateInvocation(agentId, invocationId, generation, async (_agent, session) => {
      await this.invocations.updateOne(
        { _id: invocationId, agentId, generation, status: "running" },
        { $addToSet: { provisioningAttempts: attemptId } },
        { session },
      );
    });
    return attemptId;
  }

  async endProvisioning(invocationId: string, attemptId: string): Promise<void> {
    await this.invocations.updateOne(
      { _id: invocationId },
      { $pull: { provisioningAttempts: attemptId } },
    );
  }

  async confirmCleanup(agentId: string): Promise<void> {
    await this.transaction(async (session) => {
      const agent = await this.getAgent(agentId, session);
      const run = await this.getRun(agent.runId, session);
      if (run.status === "active" || run.status === "completing")
        fail("Cannot confirm cleanup of an active run");
      if (
        await this.invocations.findOne(
          { agentId, "provisioningAttempts.0": { $exists: true } },
          { session },
        )
      )
        fail("Sandbox provisioning is still in flight; cleanup unconfirmed");
      const cleaned = await this.agents.updateOne(
        { _id: agentId, cleanupCompletedAt: null },
        { $set: { status: "stopped", sandboxId: null, cleanupCompletedAt: new Date() } },
        { session },
      );
      if (cleaned.modifiedCount) {
        // All cleanup transactions write the run's event counter before counting.
        // This prevents snapshot write skew: concurrent agents otherwise each see
        // a peer still pending and leave a fully cleaned run stuck at stopping.
        await this.event(
          session,
          { runId: run._id, agentId: "harness" },
          "agent.cleanup_confirmed",
          agentId,
        );
      }
      const remaining = await this.agents.countDocuments(
        { runId: agent.runId, cleanupCompletedAt: null },
        { session },
      );
      if (!remaining) {
        const finalized = await this.runs.updateOne(
          { _id: agent.runId, status: "stopping" },
          { $set: { status: run.finalStatus ?? "stopped", endedAt: new Date() } },
          { session },
        );
        if (finalized.modifiedCount)
          await this.event(
            session,
            { runId: run._id, agentId: "harness" },
            "run.finished",
            run._id,
            {
              status: run.finalStatus ?? "stopped",
              finalCommit: run.completion?.finalCommit,
              outcome: run.completion?.outcome,
            },
          );
      }
    });
  }

  async bindSandbox(agentId: string, sandboxId: string): Promise<void> {
    const agent = await this.getAgent(agentId);
    await this.assertActive(agent.runId);
    const update = await this.agents.updateOne(
      { _id: agentId, sandboxId: null, status: { $ne: "stopped" } },
      { $set: { sandboxId } },
    );
    if (!update.modifiedCount && (await this.getAgent(agentId)).sandboxId !== sandboxId)
      fail("Agent already has a different sandbox binding");
  }

  async stopRun(
    runId: string,
    finalStatus: "stopped" | "completed" | "failed" = "stopped",
    failure?: string,
  ): Promise<void> {
    await this.transaction(async (session) => {
      const run = await this.getRun(runId, session);
      if (!["active", "completing"].includes(run.status)) return;
      if (finalStatus === "completed" && run.completion?.status !== "checkpointed")
        fail("Completion requires the final orchestrator checkpoint");
      await this.runs.updateOne(
        { _id: runId },
        {
          $set: {
            status: "stopping",
            finalStatus,
            ...(failure ? { failure } : {}),
            ...(run.completion && finalStatus !== "completed"
              ? {
                  "completion.status": "failed",
                  "completion.error": failure ?? "Operator stopped the run before completion",
                }
              : {}),
          },
        },
        { session },
      );
      await this.wakeups.updateMany(
        { runId, status: "pending" },
        { $set: { status: "cancelled" } },
        { session },
      );
      await this.event(session, { runId, agentId: "harness" }, "run.stopping", runId, {
        finalStatus,
        failure,
      });
      const agents = await this.agents.find({ runId }, { session }).toArray();
      if (!agents.length)
        await this.runs.updateOne(
          { _id: runId },
          { $set: { status: finalStatus, endedAt: new Date() } },
          { session },
        );
      for (const agent of agents) {
        if (agent.status === "stopped") continue;
        await this.agents.updateOne(
          { _id: agent._id },
          { $inc: { generation: 1 }, $set: { status: "stopped", cleanupCompletedAt: null } },
          { session },
        );
        await this.recordInvocationEvent(
          { ...agent, generation: agent.generation + 1 },
          agent.invocationId ?? "none",
          {
            requestId: `stopped_${runId}`,
            type: "agent_stopped",
            payload: { status: "stopped" },
          },
          session,
        );
        await this.outbox.updateOne(
          { _id: hash(["stop", agent._id]) },
          {
            $setOnInsert: {
              recipientId: agent._id,
              runId,
              kind: "stop",
              status: "pending",
              createdAt: new Date(),
              attempts: 0,
            },
          },
          { session, upsert: true },
        );
      }
    });
  }
}
