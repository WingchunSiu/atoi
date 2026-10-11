import { createHash, randomUUID } from "node:crypto";
import { type ClientSession, type Db, type MongoClient } from "mongodb";
import { agentToken } from "../api/auth.js";
import {
  HarnessError,
  type RunInput,
  type SendInput,
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
    private readonly controlPlaneId?: string,
  ) {
    super(client, db);
  }
  get invocations() {
    return this.db.collection<Invocation>("invocations");
  }
  get checkpoints() {
    return this.db.collection<Checkpoint>("session_checkpoints");
  }
  override async initialize() {
    await super.initialize();
    await this.invocations.createIndex({ agentId: 1, createdAt: 1 });
    await this.checkpoints.createIndex({ agentId: 1 });
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
    await this.assertActive(agent.runId, session);
    return agent;
  }

  async createRun(input: RunInput): Promise<{ run: Run; agents: Agent[] }> {
    const runId = hash(["run", input.requestId]);
    const seeds = input.agents ?? [
      {
        role: "orchestrator",
        instructions: `Coordinate the objective with up to ${input.workerLimit ?? 2} workers. Use spawn_agent to assign focused implementation and review roles. Create tasks with acceptance criteria, delegate by DM, and end your turn while waiting. Require a pushed commit and independent exact-commit review. Workers must report task progress to you by DM. Call complete_objective only after all tasks are done; this records the outcome and keeps the team available. On follow-ups reuse existing workers, create fresh tasks, and build on the last reviewed commit. For an empty repository, create an initial commit on a task branch and push it for review; do not assume main or TASK.md exists. Never poll or invent test results.`,
      },
    ];
    // Reserve all seed identities/capacity and objective deliveries in one transaction.
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
      const run: Run & { requestHash: string } = {
        _id: runId,
        requestHash: fingerprint,
        objective: input.objective,
        ...(this.controlPlaneId ? { controlPlaneId: this.controlPlaneId } : {}),
        repository: input.repositoryUrl,
        workerLimit: input.agents?.length ?? input.workerLimit ?? 2,
        workerCount: input.agents?.length ?? 0,
        orchestratorId: null,
        status: "active",
        deadline: new Date(Date.now() + input.lifetimeSeconds * 1000),
        maxInvocationsPerAgent: input.maxInvocationsPerAgent,
        createdAt: new Date(),
      };
      await this.runs.insertOne(run, { session });
      const channelId = hash([runId, "team"]);
      await this.channels.insertOne(
        {
          _id: channelId,
          runId,
          kind: "team",
          participants: [],
          nextSequence: 0,
          createdAt: new Date(),
        },
        { session },
      );
      const agents: Agent[] = seeds.map((seed) => ({
        _id: randomUUID(),
        runId,
        ...seed,
        kind: input.agents ? "worker" : "orchestrator",
        status: "pending",
        runtimeEnabled: true,
        tokenHash: "",
        generation: 0,
        turns: 0,
        toolEpoch: 0,
        sandboxId: null,
        cleanupCompletedAt: null,
        checkpointId: null,
        invocationId: null,
        createdAt: new Date(),
      }));
      for (const agent of agents)
        agent.tokenHash = stringHash(agentToken(this.agentSecret, agent._id));
      await this.agents.insertMany(agents, { session });
      if (!input.agents) {
        run.orchestratorId = agents[0]!._id;
        await this.runs.updateOne(
          { _id: runId },
          { $set: { orchestratorId: run.orchestratorId } },
          { session },
        );
      }
      await this.event(session, { runId, agentId: "operator" }, "run.state", runId, {
        status: "running",
        objective: run.objective,
        repo: run.repository,
        workerLimit: run.workerLimit,
        deadline: run.deadline.toISOString(),
      });
      for (const [i, agent] of agents.entries()) {
        await this.event(session, { runId, agentId: agent._id }, "agent.spawned", agent._id, {
          role: agent.role,
          kind: agent.kind,
        });
        const messageId = hash([runId, "initial", agent._id]);
        const deliveryId = hash([messageId, agent._id]);
        const initialMessage = {
          _id: messageId,
          runId,
          channelId,
          senderId: "operator",
          requestId: `initial_${agent._id}`,
          fingerprint: hash(input.objective),
          body: input.objective,
          mentions: [agent._id],
          recipients: [agent._id],
          sequence: i + 1,
          createdAt: new Date(),
        };
        await this.messages.insertOne(initialMessage, { session });
        await this.event(session, { runId, agentId: "operator" }, "message.sent", messageId, {
          message: initialMessage,
          channelKind: "team",
        });
        await this.deliveries.insertOne(
          {
            _id: deliveryId,
            runId,
            recipientId: agent._id,
            messageId,
            channelId,
            sequence: i + 1,
            status: "pending",
            createdAt: new Date(),
          },
          { session },
        );
        await this.event(session, { runId, agentId: agent._id }, "delivery.queued", deliveryId, {
          deliveryId,
          messageId,
        });
        await this.outbox.insertOne(
          {
            _id: deliveryId,
            runId,
            recipientId: agent._id,
            deliveryId,
            kind: "mailbox_wakeup",
            status: "pending",
            attempts: 0,
            createdAt: new Date(),
          },
          { session },
        );
      }
      await this.channels.updateOne(
        { _id: channelId },
        { $set: { nextSequence: agents.length } },
        { session },
      );
      return { run, agents: agents.map(({ tokenHash: _secret, ...agent }) => agent) as Agent[] };
    });
  }

  async spawn(actor: Actor, input: { requestId: string; role: string; instructions: string }) {
    return this.mutateInvocation(
      actor.agentId,
      actor.invocationId!,
      actor.generation!,
      async (parent, session) => {
        if (parent.kind !== "orchestrator")
          throw new HarnessError(403, "Only the orchestrator can spawn workers");
        const run = await this.getRun(actor.runId, session);
        const agentId = hash([actor.runId, "spawn", input.requestId]);
        const prior = await this.agents.findOne({ _id: agentId }, { session });
        if (prior) {
          if (prior.spawnHash !== hash(input)) fail("Spawn request ID reused with different input");
          const { tokenHash: _token, ...view } = prior;
          return view;
        }
        if ((run.completion && !run.completion.confirmed) || run.workerCount >= run.workerLimit)
          fail("Worker capacity is exhausted or run is completing");
        await this.runs.updateOne({ _id: run._id }, { $inc: { workerCount: 1 } }, { session });
        const agent: Agent = {
          _id: agentId,
          runId: run._id,
          role: input.role,
          instructions: `${input.instructions}\nWork on a private task branch. Push before submitting for independent review. Report progress and review outcomes to orchestrator ${parent._id} by DM. End your turn while waiting for peers.`,
          kind: "worker",
          status: "pending",
          runtimeEnabled: true,
          generation: 0,
          turns: 0,
          toolEpoch: 0,
          sandboxId: null,
          cleanupCompletedAt: null,
          checkpointId: null,
          invocationId: null,
          tokenHash: stringHash(agentToken(this.agentSecret, agentId)),
          createdAt: new Date(),
          spawnHash: hash(input),
        };
        await this.agents.insertOne(agent, { session });
        await this.event(session, { runId: run._id, agentId }, "agent.spawned", agentId, {
          role: agent.role,
          kind: agent.kind,
          spawnedBy: parent._id,
        });
        const channel = (await this.channels.findOneAndUpdate(
          { runId: run._id, kind: "team" },
          { $inc: { nextSequence: 1 } },
          { session, returnDocument: "after" },
        ))!;
        const messageId = hash([agentId, "objective"]);
        const message = {
          _id: messageId,
          runId: run._id,
          channelId: channel._id,
          senderId: parent._id,
          requestId: `seed_${agentId}`,
          fingerprint: hash(input),
          body: `${run.objective}\n\nAssignment: ${input.instructions}`,
          mentions: [agentId],
          recipients: [agentId],
          sequence: channel.nextSequence,
          createdAt: new Date(),
        };
        await this.messages.insertOne(message, { session });
        await this.deliveries.insertOne(
          {
            _id: messageId,
            runId: run._id,
            recipientId: agentId,
            messageId,
            channelId: channel._id,
            sequence: message.sequence,
            status: "pending",
            createdAt: new Date(),
          },
          { session },
        );
        await this.outbox.insertOne(
          {
            _id: messageId,
            runId: run._id,
            recipientId: agentId,
            deliveryId: messageId,
            kind: "mailbox_wakeup",
            status: "pending",
            createdAt: new Date(),
          },
          { session },
        );
        await this.event(session, actor, "message.sent", messageId, {
          message,
          channelKind: "team",
        });
        await this.event(session, { runId: run._id, agentId }, "delivery.queued", messageId, {
          deliveryId: messageId,
          messageId,
        });
        const { tokenHash: _token, ...view } = agent;
        return view;
      },
    );
  }

  async completeObjective(actor: Actor, input: { commit: string; summary: string }) {
    return this.mutateInvocation(
      actor.agentId,
      actor.invocationId!,
      actor.generation!,
      async (agent, session) => {
        if (agent.kind !== "orchestrator")
          throw new HarnessError(403, "Only the orchestrator can complete an objective");
        const run = await this.getRun(actor.runId, session);
        if (run.completion && !run.completion.confirmed) {
          if (
            run.completion.invocationId !== actor.invocationId ||
            run.completion.commit !== input.commit ||
            run.completion.summary !== input.summary
          )
            fail("Conflicting completion request");
          return { status: "awaiting_checkpoint" };
        }
        const tasks = await this.tasks.find({ runId: actor.runId }, { session }).toArray();
        if (
          !tasks.length ||
          tasks.some(
            (t) => t.status !== "done" || !t.review || t.review.commit !== t.result?.commit,
          ) ||
          !tasks.some((t) => t.result?.commit === input.commit)
        )
          fail("All tasks must have independent exact-commit approval, including the final commit");
        await this.runs.updateOne(
          { _id: actor.runId },
          { $set: { completion: { ...input, invocationId: actor.invocationId! } } },
          { session },
        );
        await this.event(session, actor, "run.state", run._id, {
          status: "completing",
          finalCommit: input.commit,
          outcome: input.summary,
        });
        return { status: "awaiting_checkpoint" };
      },
    );
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

  async requestRecovery(
    runId: string,
    agentId: string,
    input: { requestId: string; commit: string },
  ) {
    return this.transaction(async (session) => {
      const agent = await this.getAgent(agentId, session);
      if (agent.runId !== runId) throw new HarnessError(404, "Agent not found in run");
      const run = await this.assertActive(runId, session);
      if (run.completion && !run.completion.confirmed)
        fail("Cannot replace a sandbox while checkpointing objective completion");
      if (agent.recovery?.requestId === input.requestId) {
        if (agent.recovery.commit !== input.commit)
          fail("Recovery request ID reused with different commit");
        return agent.recovery;
      }
      if (!agent.checkpointId || agent.invocationId || agent.status !== "idle")
        fail(
          "Replacement requires an idle agent with a confirmed checkpoint; inspect interrupted effects separately",
        );
      const recovery = { ...input, status: "pending" as const };
      await this.agents.updateOne(
        { _id: agentId },
        { $set: { recovery, status: "needs_inspection" }, $inc: { generation: 1 } },
        { session },
      );
      await this.event(session, { runId, agentId }, "agent.state", agentId, {
        state: "recovering",
        generation: agent.generation + 1,
        detail: "Stopping old sandbox before restoring checkpoint and pushed commit",
      });
      return recovery;
    });
  }

  async beginRecoveryProvisioning(agentId: string, requestId: string) {
    return this.transaction(async (session) => {
      const agent = await this.getAgent(agentId, session);
      await this.assertActive(agent.runId, session);
      if (agent.recovery?.requestId !== requestId || agent.recovery.status !== "pending")
        return null;
      const attemptId = randomUUID();
      await this.agents.updateOne(
        { _id: agentId },
        {
          $addToSet: { "recovery.provisioningAttempts": attemptId },
        },
        { session },
      );
      return { agent, attemptId };
    });
  }

  async endRecoveryProvisioning(agentId: string, requestId: string, attemptId: string) {
    await this.agents.updateOne(
      { _id: agentId, "recovery.requestId": requestId },
      {
        $pull: { "recovery.provisioningAttempts": attemptId },
      },
    );
  }

  async failRecovery(agentId: string, requestId: string) {
    await this.transaction(async (session) => {
      const agent = await this.getAgent(agentId, session);
      if (
        agent.recovery?.requestId !== requestId ||
        agent.recovery.status !== "pending" ||
        agent.status === "stopped"
      )
        return;
      const error =
        "Sandbox replacement exhausted retries; inspect cloud resources before resuming";
      await this.agents.updateOne(
        { _id: agentId },
        {
          $set: { "recovery.status": "failed", "recovery.error": error },
        },
        { session },
      );
      await this.event(session, { runId: agent.runId, agentId }, "agent.state", agentId, {
        state: "needs_inspection",
        generation: agent.generation,
        detail: error,
      });
      await this.event(session, { runId: agent.runId, agentId }, "failure.recorded", requestId, {
        failureId: `replacement_${requestId}`,
        scope: "recovery",
        message: error,
        resolved: false,
      });
    });
  }

  async finishRecovery(agentId: string, requestId: string, sandboxId: string) {
    await this.transaction(async (session) => {
      const agent = await this.getAgent(agentId, session);
      await this.assertActive(agent.runId, session);
      if (agent.recovery?.requestId !== requestId || agent.recovery.status !== "pending")
        fail("Recovery superseded");
      await this.agents.updateOne(
        { _id: agentId },
        { $set: { sandboxId, status: "idle", "recovery.status": "completed" } },
        { session },
      );
      await this.event(session, { runId: agent.runId, agentId }, "sandbox.state", agentId, {
        state: "running",
        sandboxId,
      });
      await this.event(session, { runId: agent.runId, agentId }, "agent.state", agentId, {
        state: "waiting",
        generation: agent.generation,
      });
      await this.outbox.updateOne(
        { _id: hash(["recovery", requestId, agentId]) },
        {
          $setOnInsert: {
            runId: agent.runId,
            recipientId: agentId,
            kind: "mailbox_wakeup",
            status: "pending",
            createdAt: new Date(),
          },
        },
        { session, upsert: true },
      );
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
      { session, ignoreUndefined: true },
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
      const run = await this.assertActive(agent.runId, session);
      const prior = await this.invocations.findOne({ _id: invocationId, agentId }, { session });
      if (prior) return prior;
      if (
        agent.recovery?.status === "pending" ||
        agent.recovery?.provisioningAttempts?.length ||
        agent.status === "needs_inspection" ||
        agent.status === "stopped" ||
        (run.completion && !run.completion.confirmed)
      )
        return null;
      if (agent.invocationId)
        return this.invocations.findOne({ _id: agent.invocationId }, { session });
      if (agent.turns >= run.maxInvocationsPerAgent) {
        await this.agents.updateOne(
          { _id: agentId },
          { $set: { status: "needs_inspection" } },
          { session },
        );
        await this.event(session, { runId: agent.runId, agentId }, "agent.state", agentId, {
          state: "needs_inspection",
          generation: agent.generation,
          detail: "Invocation budget exhausted",
        });
        await this.event(session, { runId: agent.runId, agentId }, "failure.recorded", agentId, {
          failureId: `budget_${agentId}`,
          scope: "invocation",
          message: "Invocation budget exhausted",
          resolved: false,
        });
        return null;
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
      await this.event(session, { runId: agent.runId, agentId }, "agent.state", agentId, {
        state: "running",
        generation: invocation.generation,
        invocationId,
      });
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
      // A plain final answer to an operator DM is a durable chat reply, even when
      // the model does not explicitly call send_message. Publish atomically with
      // its checkpoint, and avoid duplicating an explicit reply from this turn.
      if (result.outcome === "completed" && result.text.trim()) {
        const deliveries = await this.deliveries
          .find(
            { _id: { $in: invocation.deliveryIds }, invocationId: result.invocationId },
            { session },
          )
          .toArray();
        const operatorMessages = await this.messages
          .find(
            { _id: { $in: deliveries.map((d) => d.messageId) }, senderId: "operator" },
            { session },
          )
          .sort({ createdAt: -1 })
          .toArray();
        for (const message of operatorMessages) {
          const channel = await this.channels.findOne(
            { _id: message.channelId, kind: "dm", participants: "operator" },
            { session },
          );
          if (!channel) continue;
          const explicitReply = await this.messages.findOne(
            { channelId: channel._id, senderId: agentId, invocationId: result.invocationId },
            { session },
          );
          if (!explicitReply)
            await this.sendMessage(
              {
                runId: agent.runId,
                agentId,
                invocationId: result.invocationId,
                generation: result.generation,
              },
              channel._id,
              {
                requestId: `answer_${result.invocationId}`,
                body:
                  result.text.length > 32000
                    ? `${result.text.slice(0, 31900)}\n[Reply truncated; full text is in the execution record.]`
                    : result.text,
                mentions: [],
                replyTo: message._id,
              },
              session,
            );
          break; // One operator conversation per agent; coalesced DMs get one reply.
        }
      }
      const { checkpoint: _checkpoint, ...summary } = result;
      for (const delivery of await this.deliveries
        .find({ invocationId: result.invocationId }, { session })
        .toArray()) {
        await this.event(session, { runId: agent.runId, agentId }, "delivery.done", delivery._id, {
          deliveryId: delivery._id,
          messageId: delivery.messageId,
        });
      }
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
      const actor = { runId: agent.runId, agentId };
      if (result.restoredCheckpoint)
        await this.event(session, actor, "checkpoint", agentId, {
          action: "restored",
          version: Math.max(0, result.generation - 1),
        });
      await this.event(session, actor, "checkpoint", agentId, {
        action: "saved",
        version: result.generation,
      });
      await this.event(session, actor, "usage", agentId, {
        invocationId: result.invocationId,
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        costUsd: result.usage.cost,
        costKnown: result.usage.costKnown,
        durationMs: result.usage.elapsedMs,
      });
      await this.event(session, actor, "agent.state", agentId, {
        state: result.outcome === "completed" ? "waiting" : "needs_inspection",
        generation: result.generation,
      });
      const run = await this.getRun(agent.runId, session);
      if (run.completion?.invocationId === result.invocationId) {
        if (result.outcome !== "completed") {
          await this.runs.updateOne({ _id: run._id }, { $unset: { completion: "" } }, { session });
          await this.event(session, actor, "run.state", run._id, {
            status: "running",
            outcome: "Completion invocation failed; inspect the orchestrator",
          });
        } else {
          await this.runs.updateOne(
            { _id: run._id },
            { $set: { "completion.confirmed": true } },
            { session },
          );
          await this.event(session, actor, "run.state", run._id, {
            status: "available",
            finalCommit: run.completion.commit,
            outcome: run.completion.summary,
          });
        }
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
      if (current)
        await this.event(session, { runId: agent.runId, agentId }, "agent.state", agentId, {
          state: "needs_inspection",
          generation: agent.generation,
          detail: error.slice(0, 4000),
        });
      await this.event(
        session,
        { runId: agent.runId, agentId },
        "failure.recorded",
        invocationId ?? agentId,
        {
          failureId: invocationId ?? agentId,
          scope: "invocation",
          message: error.slice(0, 4000),
          resolved: false,
        },
      );
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
      if (agent.cleanupCompletedAt) return;
      if (run.status === "active") fail("Cannot confirm cleanup of an active run");
      if (agent.recovery?.provisioningAttempts?.length)
        fail("Sandbox replacement is still in flight; cleanup unconfirmed");
      if (
        await this.invocations.findOne(
          { agentId, "provisioningAttempts.0": { $exists: true } },
          { session },
        )
      )
        fail("Sandbox provisioning is still in flight; cleanup unconfirmed");
      await this.agents.updateOne(
        { _id: agentId, cleanupCompletedAt: null },
        { $set: { status: "stopped", sandboxId: null, cleanupCompletedAt: new Date() } },
        { session },
      );
      const remaining = await this.agents.countDocuments(
        { runId: agent.runId, cleanupCompletedAt: null },
        { session },
      );
      await this.event(session, { runId: agent.runId, agentId }, "agent.state", agentId, {
        state: "stopped",
        generation: agent.generation,
      });
      if (agent.sandboxId)
        await this.event(session, { runId: agent.runId, agentId }, "sandbox.state", agentId, {
          state: "terminated",
          sandboxId: agent.sandboxId,
        });
      if (!remaining) {
        await this.runs.updateOne(
          { _id: agent.runId, status: "stopping" },
          { $set: { status: "stopped" } },
          { session },
        );
        await this.event(
          session,
          { runId: agent.runId, agentId: "operator" },
          "run.state",
          run._id,
          {
            status: run.completion?.confirmed ? "completed" : "cancelled",
            finalCommit: run.completion?.confirmed ? run.completion.commit : undefined,
            outcome: run.completion?.confirmed
              ? run.completion.summary
              : "Stopped by operator or deadline",
          },
        );
      }
    });
  }

  async bindSandbox(agentId: string, sandboxId: string): Promise<void> {
    return this.transaction(async (session) => {
      const agent = await this.getAgent(agentId, session);
      await this.assertActive(agent.runId, session);
      const update = await this.agents.updateOne(
        { _id: agentId, sandboxId: null, status: { $ne: "stopped" } },
        { $set: { sandboxId } },
        { session },
      );
      if (!update.modifiedCount && (await this.getAgent(agentId, session)).sandboxId !== sandboxId)
        fail("Agent already has a different sandbox binding");
      if (update.modifiedCount)
        await this.event(session, { runId: agent.runId, agentId }, "sandbox.state", agentId, {
          state: "running",
          sandboxId,
        });
    });
  }

  async stopRun(runId: string, session?: ClientSession): Promise<void> {
    if (!session) return this.transaction((active) => this.stopRun(runId, active));
    const run = await this.getRun(runId, session);
    if (run.status !== "active") return;
    await this.runs.updateOne({ _id: runId }, { $set: { status: "stopping" } }, { session });
    await this.event(session, { runId, agentId: "operator" }, "run.state", runId, {
      status: "completing",
      outcome: run.completion?.confirmed
        ? run.completion.summary
        : "Stopping; waiting for sandbox cleanup",
    });
    const agents = await this.agents.find({ runId }, { session }).toArray();
    if (!agents.length)
      await this.runs.updateOne({ _id: runId }, { $set: { status: "stopped" } }, { session });
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
  }
}
