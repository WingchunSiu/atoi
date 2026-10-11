import { beforeEach, describe, expect, it } from "vitest";
import { fold, initialState, reduce } from "../src/state/reduce";
import { ev, resetSeq } from "./helpers";

beforeEach(resetSeq);

const spawn = (agentId: string, role: string, kind = "worker") =>
  ev({ type: "agent.spawned", agentId, role, kind });

describe("reduce", () => {
  it("ignores events whose seq is not greater than the last applied", () => {
    const a = ev({ type: "worker.restarted" }, 5);
    const s1 = reduce(initialState(), a);
    expect(reduce(s1, a)).toBe(s1);
    expect(reduce(s1, ev({ type: "worker.restarted" }, 3))).toBe(s1);
    expect(s1.workerRestarts).toHaveLength(1);
    expect(s1.lastSeq).toBe(5);
  });

  it("advances lastSeq on unknown types and otherwise ignores them", () => {
    const s = fold([
      spawn("a_1", "implementer"),
      ev({ type: "agent.mood", agentId: "a_2", mood: "x" }),
    ]);
    expect(s.lastSeq).toBe(2);
    expect(Object.keys(s.agents)).toEqual(["a_1"]);
  });

  it("creates placeholder agents for out-of-order events and fills them in on spawn", () => {
    const s1 = fold([
      ev({ type: "agent.state", agentId: "a_rev", state: "waiting", generation: 1 }),
    ]);
    expect(s1.agents.a_rev).toMatchObject({ role: "unknown", spawned: false, state: "waiting" });
    const s2 = reduce(
      s1,
      ev({
        type: "agent.spawned",
        agentId: "a_rev",
        role: "reviewer",
        kind: "worker",
        spawnedBy: "a_orch",
      }),
    );
    expect(s2.agents.a_rev).toMatchObject({
      role: "reviewer",
      spawned: true,
      spawnedBy: "a_orch",
      state: "waiting",
      joinedSeq: 1,
    });
  });

  it("creates placeholders for message senders and recipients", () => {
    const s = fold([
      ev({
        type: "message.sent",
        agentId: "a_x",
        messageId: "m_1",
        channelId: "dm:a_x|a_y",
        channelKind: "dm",
        from: "a_x",
        to: ["a_y"],
        body: "hi",
      }),
    ]);
    expect(Object.keys(s.agents).sort()).toEqual(["a_x", "a_y"]);
  });

  it("orders the orchestrator first, then by join order", () => {
    const s = fold([
      spawn("a_impl", "implementer"),
      spawn("a_rev", "reviewer"),
      spawn("a_orch", "orchestrator", "orchestrator"),
    ]);
    expect(s.agentOrder).toEqual(["a_orch", "a_impl", "a_rev"]);
  });

  it("queues and drains deliveries", () => {
    const s1 = fold([
      spawn("a_rev", "reviewer"),
      ev({ type: "delivery.queued", agentId: "a_rev", deliveryId: "d_1", messageId: "m_1" }),
      ev({ type: "delivery.queued", agentId: "a_rev", deliveryId: "d_2", messageId: "m_2" }),
      ev({ type: "delivery.queued", agentId: "a_rev", deliveryId: "d_1", messageId: "m_1" }),
    ]);
    expect(s1.agents.a_rev!.pendingDeliveries).toEqual(["d_1", "d_2"]);
    const s2 = reduce(
      s1,
      ev({ type: "delivery.done", agentId: "a_rev", deliveryId: "d_1", messageId: "m_1" }),
    );
    expect(s2.agents.a_rev!.pendingDeliveries).toEqual(["d_2"]);
    expect(s2.deliveries.d_1!.done).toBe(true);
  });

  it("counts peer links for DMs only, never for team messages or mentions", () => {
    const team = (to: string[]) =>
      ev({
        type: "message.sent",
        agentId: "a_1",
        messageId: `m_t${to.length}`,
        channelId: "team",
        channelKind: "team",
        from: "a_1",
        to,
        body: "@a_2 hi",
      });
    const dm = (id: string, from: string, to: string) =>
      ev({
        type: "message.sent",
        agentId: from,
        messageId: id,
        channelId: "dm:a_1|a_2",
        channelKind: "dm",
        from,
        to: [to],
        body: "hi",
      });
    const s1 = fold([spawn("a_1", "a"), spawn("a_2", "b"), team([]), team(["a_2"])]);
    expect(s1.peerLinks).toEqual({});
    expect(s1.channels.team!.count).toBe(2);
    const s2 = fold(
      [dm("m_1", "a_1", "a_2"), dm("m_2", "a_2", "a_1"), dm("m_3", "a_1", "a_2")],
      s1,
    );
    expect(Object.keys(s2.peerLinks)).toEqual(["a_1|a_2"]);
    expect(s2.peerLinks["a_1|a_2"]).toMatchObject({ count: 3, firstSeq: 5 });
  });

  it("tracks generations and sandbox ID history", () => {
    const s = fold([
      spawn("a_rev", "reviewer"),
      ev({ type: "sandbox.state", agentId: "a_rev", state: "running", sandboxId: "sb-2c3" }),
      ev({ type: "agent.state", agentId: "a_rev", state: "waiting", generation: 1 }),
      ev({ type: "sandbox.state", agentId: "a_rev", state: "terminated", sandboxId: "sb-2c3" }),
      ev({
        type: "agent.state",
        agentId: "a_rev",
        state: "recovering",
        generation: 2,
        detail: "replacing sandbox",
      }),
      ev({ type: "sandbox.state", agentId: "a_rev", state: "starting", sandboxId: "sb-9d4" }),
      ev({ type: "sandbox.state", agentId: "a_rev", state: "running", sandboxId: "sb-9d4" }),
    ]);
    const a = s.agents.a_rev!;
    expect(a.generation).toBe(2);
    expect(a.sandbox).toMatchObject({ id: "sb-9d4", state: "running", previousIds: ["sb-2c3"] });
    expect(s.sandboxReplacements).toEqual([
      expect.objectContaining({
        agentId: "a_rev",
        oldId: "sb-2c3",
        newId: "sb-9d4",
        generation: 2,
      }),
    ]);
    expect(a.stateHistory.map((h) => h.state)).toEqual(["waiting", "recovering"]);
  });

  it("clears wakeAt when the agent leaves waiting", () => {
    const wakeAt = "2026-10-11T14:00:00.000Z";
    const s1 = fold([
      spawn("a_rev", "reviewer"),
      ev({ type: "agent.state", agentId: "a_rev", state: "waiting", generation: 1, wakeAt }),
    ]);
    expect(s1.agents.a_rev!.wakeAt).toBe(wakeAt);
    const s2 = reduce(
      s1,
      ev({ type: "agent.state", agentId: "a_rev", state: "running", generation: 1 }),
    );
    expect(s2.agents.a_rev!.wakeAt).toBeUndefined();
  });

  it("keeps task history only for status, owner or result changes", () => {
    const task = { id: "T1", title: "t", status: "open" };
    const s = fold([
      ev({ type: "task.upserted", agentId: "a_orch", task }),
      ev({ type: "task.upserted", agentId: "a_orch", task: { ...task, title: "renamed" } }),
      ev({
        type: "task.upserted",
        agentId: "a_impl",
        task: { ...task, status: "in_progress", ownerId: "a_impl" },
      }),
      ev({
        type: "task.upserted",
        agentId: "a_impl",
        task: { ...task, status: "in_progress", ownerId: "a_impl", resultCommit: "a1b2c3d" },
      }),
    ]);
    const t = s.tasks.T1!;
    expect(t.createdSeq).toBe(1);
    expect(t.createdBy).toBe("a_orch");
    expect(t.title).toBe("t");
    expect(t.history.map((h) => [h.status, h.ownerId, h.resultCommit])).toEqual([
      ["open", undefined, undefined],
      ["in_progress", "a_impl", undefined],
      ["in_progress", "a_impl", "a1b2c3d"],
    ]);
  });

  it("accepts a verification before its push", () => {
    const s1 = fold([
      ev({
        type: "verification.recorded",
        agentId: "a_rev",
        commit: "a1b2c3d",
        command: "npm test",
        passed: false,
      }),
    ]);
    expect(s1.commits.a1b2c3d).toMatchObject({
      pushed: false,
      verifications: [expect.objectContaining({ passed: false })],
    });
    const s2 = reduce(
      s1,
      ev({ type: "git.pushed", agentId: "a_impl", branch: "task/T1", commit: "a1b2c3d" }),
    );
    expect(s2.commits.a1b2c3d).toMatchObject({
      pushed: true,
      branch: "task/T1",
      agentId: "a_impl",
    });
    expect(s2.commits.a1b2c3d!.verifications).toHaveLength(1);
  });

  it("upserts failures by failureId", () => {
    const s = fold([
      ev({
        type: "failure.recorded",
        failureId: "f_1",
        scope: "relay",
        message: "failed",
        resolved: false,
      }),
      ev({
        type: "failure.recorded",
        failureId: "f_1",
        scope: "relay",
        message: "resent",
        resolved: true,
      }),
    ]);
    expect(Object.values(s.failures)).toEqual([
      expect.objectContaining({
        id: "f_1",
        seq: 1,
        updatedSeq: 2,
        message: "resent",
        resolved: true,
      }),
    ]);
  });

  it("merges run state and records start and end", () => {
    const s = fold([
      ev({ type: "run.state", status: "starting", objective: "o", workerLimit: 2 }),
      ev({ type: "run.state", status: "running" }),
      ev({ type: "run.state", status: "completed", finalCommit: "b4e5f6a" }),
    ]);
    expect(s.run).toMatchObject({
      status: "completed",
      objective: "o",
      workerLimit: 2,
      finalCommit: "b4e5f6a",
    });
    expect(s.run!.startedAt).toBeDefined();
    expect(s.run!.endedAt).toBeDefined();
  });

  it("adds usage per agent", () => {
    const u = {
      type: "usage",
      agentId: "a_1",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
      durationMs: 1000,
    };
    const s = fold([ev(u), ev(u)]);
    expect(s.agents.a_1!.usage).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      costUsd: 0.02,
      durationMs: 2000,
    });
  });
});
