import { createHash, randomUUID } from "node:crypto";
import { type ClientSession, type Db, type MongoClient, MongoServerError } from "mongodb";
import {
  type Actor,
  type Agent,
  type AgentEvent,
  type Channel,
  type Delivery,
  type Message,
  type OutboxEvent,
  Problem,
  type Run,
  requireValue,
  type Task,
} from "./model.js";
import type { NewAgent, NewMessage, NewRun, NewTask, UpdateTask } from "./schemas.js";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stableId = (...parts: string[]) => hash(JSON.stringify(parts));
const conflict = (message: string) => new Problem(409, "conflict", message);
const forbidden = (message: string) => new Problem(403, "forbidden", message);

export class CoordinationStore {
  readonly runs;
  readonly agents;
  readonly tasks;
  readonly channels;
  readonly messages;
  readonly deliveries;
  readonly outbox;
  readonly events;
  constructor(
    readonly client: MongoClient,
    readonly db: Db,
    protected readonly collectionPrefix = "",
  ) {
    this.runs = db.collection<Run>(`${collectionPrefix}runs`);
    this.agents = db.collection<Agent>(`${collectionPrefix}agents`);
    this.tasks = db.collection<Task>(`${collectionPrefix}tasks`);
    this.channels = db.collection<Channel>(`${collectionPrefix}channels`);
    this.messages = db.collection<Message>(`${collectionPrefix}messages`);
    this.deliveries = db.collection<Delivery>(`${collectionPrefix}deliveries`);
    this.outbox = db.collection<OutboxEvent>(`${collectionPrefix}outbox`);
    this.events = db.collection<AgentEvent>(`${collectionPrefix}agent_events`);
  }
  async initialize() {
    // Pre-create collections/indexes; no DDL during business transactions.
    await this.runs.createIndex({ createdAt: 1 });
    await this.agents.createIndex({ tokenHash: 1 }, { unique: true });
    await this.agents.createIndex({ runId: 1, _id: 1 });
    await this.tasks.createIndex({ runId: 1, _id: 1 });
    await this.tasks.createIndex({ runId: 1, createdBy: 1, requestId: 1 }, { unique: true });
    await this.channels.createIndex({ runId: 1, _id: 1 });
    await this.messages.createIndex({ runId: 1, senderId: 1, requestId: 1 }, { unique: true });
    await this.messages.createIndex({ channelId: 1, sequence: 1 }, { unique: true });
    await this.deliveries.createIndex({ recipientId: 1, messageId: 1 }, { unique: true });
    await this.deliveries.createIndex({ runId: 1, recipientId: 1, status: 1, _id: 1 });
    await this.outbox.createIndex({ status: 1, createdAt: 1 });
    await this.events.createIndex({ runId: 1, createdAt: 1 });
    await this.events.createIndex(
      { runId: 1, sequence: 1 },
      { unique: true, partialFilterExpression: { sequence: { $type: "number" } } },
    );
    await this.events.createIndex({ runId: 1, actorId: 1, sequence: 1 });
  }
  async transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    // The driver retries transient transaction errors. A simultaneous idempotent
    // insert can instead produce E11000; retry the read in a fresh snapshot.
    for (let attempt = 0; ; attempt++) {
      const session = this.client.startSession();
      try {
        return await session.withTransaction(() => fn(session), {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          maxCommitTimeMS: 10000,
          timeoutMS: 15000,
        });
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000 && attempt < 2) continue;
        if (error instanceof MongoServerError && error.code === 11000)
          throw conflict("A unique identifier or credential is already in use");
        throw error;
      } finally {
        await session.endSession();
      }
    }
  }
  async event(
    session: ClientSession,
    actor: Actor,
    kind: string,
    entityId: string,
    details: Record<string, unknown> = {},
  ) {
    const run = requireValue(
      await this.runs.findOneAndUpdate(
        { _id: actor.runId },
        { $inc: { eventSequence: 1 } },
        { session, returnDocument: "after" },
      ),
    );
    await this.events.insertOne(
      {
        _id: randomUUID(),
        runId: actor.runId,
        actorId: actor.agentId,
        kind,
        entityId,
        details,
        sequence: run.eventSequence!,
        generation: actor.generation,
        createdAt: new Date(),
      },
      { session },
    );
  }
  async authenticate(
    token: string,
    runId: string,
    invocation?: { id: string; generation: number },
  ): Promise<Actor> {
    const agent = await this.agents.findOne({ tokenHash: hash(token), runId });
    if (!agent)
      throw new Problem(401, "unauthorized", "Valid agent credentials for this run are required");
    if (agent.runtimeEnabled) {
      if (!invocation) throw conflict("Current invocation credentials are required");
      if (
        agent.status !== "running" ||
        agent.invocationId !== invocation.id ||
        agent.generation !== invocation.generation
      )
        throw conflict("Stale or inactive agent invocation");
      const actor = {
        agentId: agent._id,
        runId,
        invocationId: invocation.id,
        generation: invocation.generation,
      };
      // Only the accepted final invocation may keep uploading activity while
      // completing. Individual mutation methods still require an active run.
      const run = await this.runs.findOne({ _id: runId });
      const finishing =
        run?.status === "completing" &&
        run.orchestratorId === agent._id &&
        run.completion?.invocationId === invocation.id &&
        run.completion.generation === invocation.generation &&
        run.deadline > new Date();
      if (!finishing) await this.authorizeActor(actor);
      return actor;
    }
    return { agentId: agent._id, runId };
  }
  async authorizeActor(actor: Actor, session?: ClientSession) {
    const run = await this.activeRun(actor.runId, session);
    if (run.deadline <= new Date()) throw conflict("Run deadline has passed");
    if (actor.agentId === "operator") return;
    const agent = requireValue(
      await this.agents.findOne({ _id: actor.agentId, runId: actor.runId }, { session }),
    );
    if (agent.runtimeEnabled) {
      if (
        agent.status !== "running" ||
        !actor.invocationId ||
        agent.invocationId !== actor.invocationId ||
        agent.generation !== actor.generation
      )
        throw conflict("Stale or inactive agent invocation");
      // A transactional write conflicts with checkpoint publication or stop/replacement.
      if (session)
        await this.agents.updateOne(
          { _id: agent._id, generation: actor.generation },
          { $inc: { toolEpoch: 1 } },
          { session },
        );
    }
  }
  async activeRun(runId: string, session?: ClientSession) {
    return requireValue(
      await this.runs.findOne({ _id: runId, status: "active" }, { session }),
      "Active run not found",
    );
  }
  async putRun(id: string, input: NewRun) {
    return this.transaction(async (session) => {
      const previous = await this.runs.findOne({ _id: id }, { session });
      if (previous) {
        if (
          previous.objective !== input.objective ||
          previous.repository !== input.repository ||
          previous.workerLimit !== input.workerLimit ||
          previous.lifetimeSeconds !== input.lifetimeSeconds ||
          previous.maxInvocationsPerAgent !== (input.maxInvocationsPerAgent ?? 20)
        )
          throw conflict("Run ID already exists with different configuration");
        return previous;
      }
      const run: Run = {
        _id: id,
        ...input,
        status: "active",
        deadline: new Date(Date.now() + (input.lifetimeSeconds ?? 3600) * 1000),
        maxInvocationsPerAgent: input.maxInvocationsPerAgent ?? 20,
        workerCount: 0,
        orchestratorId: null,
        createdAt: new Date(),
      };
      await this.runs.insertOne(run, { session });
      await this.channels.insertOne(
        {
          _id: stableId(id, "team"),
          runId: id,
          kind: "team",
          participants: [],
          nextSequence: 0,
          createdAt: new Date(),
        },
        { session },
      );
      return run;
    });
  }
  async putAgent(runId: string, id: string, input: NewAgent) {
    if (input.runtimeEnabled)
      throw new Problem(
        400,
        "invalid_input",
        "Admin registration is coordination-only; use /operator/runs for runtime agents",
      );
    return this.transaction(async (session) => {
      const run = await this.activeRun(runId, session);
      const previous = await this.agents.findOne({ _id: id }, { session });
      if (previous) {
        if (
          previous.runId !== runId ||
          previous.role !== input.role ||
          previous.kind !== input.kind ||
          previous.instructions !== (input.instructions ?? input.role) ||
          previous.runtimeEnabled !== false ||
          previous.tokenHash !== hash(input.token)
        )
          throw conflict("Agent ID already exists with different configuration");
        const { tokenHash: _, ...publicAgent } = previous;
        return publicAgent;
      }
      if (input.kind === "worker") {
        const reserved = await this.runs.updateOne(
          { _id: runId, workerCount: { $lt: run.workerLimit } },
          { $inc: { workerCount: 1 } },
          { session },
        );
        if (!reserved.matchedCount) throw conflict("Worker limit reached");
      } else {
        const reserved = await this.runs.updateOne(
          { _id: runId, orchestratorId: null },
          { $set: { orchestratorId: id } },
          { session },
        );
        if (!reserved.matchedCount) throw conflict("Run already has an orchestrator");
      }
      const agent: Agent = {
        _id: id,
        runId,
        role: input.role,
        kind: input.kind,
        tokenHash: hash(input.token),
        status: "idle",
        instructions: input.instructions ?? input.role,
        runtimeEnabled: false,
        generation: 0,
        turns: 0,
        toolEpoch: 0,
        sandboxId: null,
        cleanupCompletedAt: null,
        checkpointId: null,
        invocationId: null,
        createdAt: new Date(),
      };
      await this.agents.insertOne(agent, { session });
      await this.event(session, { runId, agentId: "operator" }, "agent.registered", id);
      const { tokenHash: _, ...publicAgent } = agent;
      return publicAgent;
    });
  }
  async listAgents(actor: Actor, after?: string, limit = 50) {
    return this.agents
      .find(
        { runId: actor.runId, ...(after ? { _id: { $gt: after } } : {}) },
        { projection: { tokenHash: 0 } },
      )
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }
  async createTask(actor: Actor, input: NewTask) {
    const normalized = {
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      dependencies: [...input.dependencies].sort(),
    };
    const fingerprint = hash(JSON.stringify(normalized));
    const id = stableId(actor.runId, actor.agentId, "task", input.requestId);
    return this.transaction(async (session) => {
      await this.authorizeActor(actor, session);
      const existing = await this.tasks.findOne({ _id: id }, { session });
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw conflict("Task request ID reused with different content");
        return existing;
      }
      await this.activeRun(actor.runId, session);
      const dependencyCount = await this.tasks.countDocuments(
        { runId: actor.runId, _id: { $in: normalized.dependencies } },
        { session },
      );
      if (dependencyCount !== normalized.dependencies.length)
        throw new Problem(400, "invalid_dependencies", "Dependencies must exist in this run");
      const task: Task = {
        ...normalized,
        _id: id,
        runId: actor.runId,
        createdBy: actor.agentId,
        requestId: input.requestId,
        fingerprint,
        status: "open",
        ownerId: null,
        reviewerId: null,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await this.tasks.insertOne(task, { session });
      await this.event(session, actor, "task.created", id);
      return task;
    });
  }
  async listTasks(actor: Actor, after?: string, limit = 50) {
    return this.tasks
      .find({ runId: actor.runId, ...(after ? { _id: { $gt: after } } : {}) })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }
  async claimTask(actor: Actor, id: string) {
    return this.transaction(async (session) => {
      await this.authorizeActor(actor, session);
      const task = requireValue(
        await this.tasks.findOne({ _id: id, runId: actor.runId }, { session }),
      );
      if (task.status === "in_progress" && task.ownerId === actor.agentId) return task;
      if (task.status !== "open" || task.ownerId !== null)
        throw conflict("Task is not available to claim");
      const pending = await this.tasks.countDocuments(
        { runId: actor.runId, _id: { $in: task.dependencies }, status: { $ne: "done" } },
        { session },
      );
      if (pending) throw conflict("Task dependencies are not done");
      const updated = await this.tasks.findOneAndUpdate(
        { _id: id, runId: actor.runId, status: "open", ownerId: null, version: task.version },
        {
          $set: { status: "in_progress", ownerId: actor.agentId, updatedAt: new Date() },
          $inc: { version: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!updated) throw conflict("Task was claimed concurrently");
      await this.event(session, actor, "task.claimed", id);
      return updated;
    });
  }
  async updateTask(actor: Actor, id: string, input: UpdateTask) {
    return this.transaction(async (session) => {
      await this.authorizeActor(actor, session);
      const task = requireValue(
        await this.tasks.findOne({ _id: id, runId: actor.runId }, { session }),
      );
      if (task.version !== input.expectedVersion)
        throw conflict("Task version changed; read the latest state before updating");
      const next: Task = { ...task, version: task.version + 1, updatedAt: new Date() };
      if (task.status === "in_review") {
        if (actor.agentId !== task.reviewerId)
          throw forbidden("Only the assigned reviewer can resolve review");
        if (input.status === "done") {
          if (!input.review)
            throw new Problem(
              400,
              "invalid_review",
              "Reviewer must supply review.verification, not result. A commit is only needed when the submitted result has one.",
            );
          if (input.review.commit !== task.result?.commit)
            throw new Problem(
              400,
              "invalid_review",
              "Review must verify the exact submitted commit",
            );
          next.review = input.review;
        } else if (input.status === "in_progress" && input.reason) {
          next.reason = input.reason;
          delete next.result;
          delete next.review;
          next.reviewerId = null;
        } else throw conflict("Review can be approved or returned to the owner with a reason");
        if (input.result || input.reviewerId)
          throw new Problem(400, "invalid_update", "Reviewer cannot replace the submitted result");
      } else {
        if (actor.agentId !== task.ownerId) throw forbidden("Only the owner can update this task");
        if (input.review)
          throw new Problem(
            400,
            "invalid_update",
            "Review evidence is only accepted from the reviewer",
          );
        if (task.status === "in_progress" && input.status === "in_review") {
          if (!input.result || !input.reviewerId)
            throw new Problem(400, "invalid_review", "A result and reviewer are required");
          if (input.reviewerId === actor.agentId)
            throw forbidden("The owner cannot review their own task");
          requireValue(
            await this.agents.findOne({ _id: input.reviewerId, runId: actor.runId }, { session }),
            "Reviewer not found in this run",
          );
          next.result = input.result;
          next.reviewerId = input.reviewerId;
          delete next.reason;
        } else if (task.status === "in_progress" && input.status === "done" && input.result) {
          if (input.reviewerId)
            throw new Problem(400, "invalid_update", "Submit in_review when requesting a reviewer");
          next.result = input.result;
          next.reviewerId = null;
          delete next.review;
          delete next.reason;
        } else if (task.status === "in_progress" && input.status === "blocked" && input.reason) {
          next.reason = input.reason;
        } else if (task.status === "blocked" && input.status === "in_progress") {
          delete next.reason;
        } else throw conflict("Invalid task transition");
        if (!["in_review", "done"].includes(input.status) && (input.result || input.reviewerId))
          throw new Problem(
            400,
            "invalid_update",
            "Result fields require task completion or submission for review",
          );
      }
      next.status = input.status;
      const replaced = await this.tasks.replaceOne(
        { _id: id, runId: actor.runId, version: input.expectedVersion },
        next,
        { session },
      );
      if (!replaced.matchedCount) throw conflict("Task changed concurrently");
      await this.event(session, actor, "task.updated", id, {
        from: task.status,
        to: next.status,
        version: next.version,
        reason: input.reason ?? null,
        result: input.result ?? null,
        review: input.review ?? null,
        reviewerId: next.reviewerId,
      });
      return next;
    });
  }
  async listChannels(actor: Actor, after?: string, limit = 50) {
    return this.channels
      .find({
        runId: actor.runId,
        $or: [{ kind: "team" }, { participants: actor.agentId }],
        ...(after ? { _id: { $gt: after } } : {}),
      })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }
  async dm(actor: Actor, peerId: string) {
    if (peerId === actor.agentId)
      throw new Problem(400, "invalid_peer", "Choose a different agent");
    const participants = [actor.agentId, peerId].sort();
    const id = stableId(actor.runId, "dm", ...participants);
    return this.transaction(async (session) => {
      await this.authorizeActor(actor, session);
      if (peerId !== "operator")
        requireValue(
          await this.agents.findOne({ _id: peerId, runId: actor.runId }, { session }),
          "Peer not found in this run",
        );
      const existing = await this.channels.findOne({ _id: id }, { session });
      if (existing) return existing;
      const channel: Channel = {
        _id: id,
        runId: actor.runId,
        kind: "dm",
        participants,
        nextSequence: 0,
        createdAt: new Date(),
      };
      await this.channels.insertOne(channel, { session });
      return channel;
    });
  }
  async channel(actor: Actor, channelId: string, session?: ClientSession) {
    return requireValue(
      await this.channels.findOne(
        {
          _id: channelId,
          runId: actor.runId,
          $or: [{ kind: "team" }, { participants: actor.agentId }],
        },
        { session },
      ),
    );
  }
  async sendMessage(actor: Actor, channelId: string, input: NewMessage) {
    const mentions = [...input.mentions].sort();
    const fingerprint = hash(
      JSON.stringify({ channelId, body: input.body, mentions, replyTo: input.replyTo }),
    );
    const id = stableId(actor.runId, actor.agentId, "message", input.requestId);
    return this.transaction(async (session) => {
      await this.authorizeActor(actor, session);
      const channel = await this.channel(actor, channelId, session);
      const existing = await this.messages.findOne({ _id: id }, { session });
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw conflict("Message request ID reused with different content");
        return existing;
      }
      if (
        input.replyTo &&
        !(await this.messages.findOne(
          { _id: input.replyTo, channelId, runId: actor.runId },
          { session },
        ))
      )
        throw new Problem(400, "invalid_reply", "Reply must reference a message in this channel");
      const memberCount = await this.agents.countDocuments(
        { runId: actor.runId, _id: { $in: mentions } },
        { session },
      );
      if (
        memberCount !== mentions.length ||
        (channel.kind === "dm" && mentions.some((id) => !channel.participants.includes(id)))
      )
        throw new Problem(400, "invalid_mentions", "Mentions must be members of this channel");
      const recipients = (channel.kind === "dm" ? channel.participants : mentions).filter(
        (id) => id !== actor.agentId && id !== "operator",
      );
      const counter = requireValue(
        await this.channels.findOneAndUpdate(
          { _id: channelId },
          { $inc: { nextSequence: 1 } },
          { session, returnDocument: "after" },
        ),
      );
      const message: Message = {
        _id: id,
        runId: actor.runId,
        channelId,
        senderId: actor.agentId,
        requestId: input.requestId,
        fingerprint,
        body: input.body,
        mentions,
        recipients,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        sequence: counter.nextSequence,
        createdAt: new Date(),
      };
      await this.messages.insertOne(message, { session });
      for (const recipientId of recipients) {
        const deliveryId = stableId(id, recipientId);
        await this.deliveries.insertOne(
          {
            _id: deliveryId,
            runId: actor.runId,
            recipientId,
            messageId: id,
            channelId,
            sequence: message.sequence,
            status: "pending",
            createdAt: new Date(),
          },
          { session },
        );
        await this.outbox.insertOne(
          {
            _id: deliveryId,
            runId: actor.runId,
            recipientId,
            deliveryId,
            kind: "mailbox_wakeup",
            status: "pending",
            createdAt: new Date(),
          },
          { session },
        );
      }
      await this.event(session, actor, "message.sent", id, { channelId, recipientIds: recipients });
      return message;
    });
  }
  async readChannel(actor: Actor, channelId: string, after = 0, limit = 50) {
    await this.channel(actor, channelId);
    return this.messages
      .find({ runId: actor.runId, channelId, sequence: { $gt: after } })
      .sort({ sequence: 1 })
      .limit(limit)
      .toArray();
  }
  async inbox(actor: Actor, after?: string, limit = 50) {
    return this.deliveries
      .find({
        runId: actor.runId,
        recipientId: actor.agentId,
        status: "pending",
        ...(after ? { _id: { $gt: after } } : {}),
      })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }
}
