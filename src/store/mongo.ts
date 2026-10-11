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
        repository: input.repositoryUrl,
        workerLimit: input.agents.length,
        workerCount: input.agents.length,
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
      const agents: Agent[] = input.agents.map((seed) => ({
        _id: randomUUID(),
        runId,
        ...seed,
        kind: "worker",
        status: "pending",
        runtimeEnabled: true,
        tokenHash: "",
        generation: 0,
        turns: 0,
        toolEpoch: 0,
        sandboxId: null,
        checkpointId: null,
        invocationId: null,
        createdAt: new Date(),
      }));
      for (const agent of agents)
        agent.tokenHash = stringHash(agentToken(this.agentSecret, agent._id));
      await this.agents.insertMany(agents, { session });
      for (const [i, agent] of agents.entries()) {
        const messageId = hash([runId, "initial", agent._id]);
        const deliveryId = hash([messageId, agent._id]);
        await this.messages.insertOne(
          {
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
          },
          { session },
        );
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
      const run = await this.assertActive(agent.runId, session);
      const prior = await this.invocations.findOne({ _id: invocationId, agentId }, { session });
      if (prior) return prior;
      if (agent.status === "needs_inspection" || agent.status === "stopped") return null;
      if (agent.invocationId)
        return this.invocations.findOne({ _id: agent.invocationId }, { session });
      if (agent.turns >= run.maxInvocationsPerAgent) {
        await this.agents.updateOne(
          { _id: agentId },
          { $set: { status: "needs_inspection" } },
          { session },
        );
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
    });
  }

  async uncertain(agentId: string, invocationId: string, error: string): Promise<void> {
    await this.transaction(async (session) => {
      const invocation = await this.invocations.findOne(
        { _id: invocationId, agentId },
        { session },
      );
      if (!invocation || invocation.status === "completed" || invocation.status === "uncertain")
        return;
      const agent = await this.getAgent(agentId, session);
      await this.invocations.updateOne(
        { _id: invocationId },
        { $set: { status: "uncertain", error: error.slice(0, 4000) } },
        { session },
      );
      await this.agents.updateOne(
        { _id: agentId, invocationId },
        { $set: { status: "needs_inspection" } },
        { session },
      );
      await this.recordInvocationEvent(
        { ...agent, generation: invocation.generation },
        invocationId,
        {
          requestId: `uncertain_${invocationId}`,
          type: "invocation_uncertain",
          payload: {
            ...(agent.invocationId === invocationId ? { status: "needs_inspection" } : {}),
            error: error.slice(0, 4000),
          },
        },
        session,
      );
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

  async stopRun(runId: string): Promise<void> {
    await this.transaction(async (session) => {
      const run = await this.getRun(runId, session);
      if (run.status === "stopped") return;
      await this.runs.updateOne({ _id: runId }, { $set: { status: "stopping" } }, { session });
      const agents = await this.agents.find({ runId }, { session }).toArray();
      for (const agent of agents) {
        if (agent.status === "stopped") continue;
        await this.agents.updateOne(
          { _id: agent._id },
          { $inc: { generation: 1 }, $set: { status: "stopped" } },
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
