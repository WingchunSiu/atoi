// Acceptance checks 4-8 from the plan, run against the folded fixtures (mock data only).
import { describe, expect, it } from "vitest";
import { USER_ID } from "../src/contract/events";
import { dmItems, teamItems, unknownCount, userDmKey } from "../src/state/chat";
import { fold, type RunState } from "../src/state/reduce";
import { selectHandoff, selectResult, selectSlots } from "../src/state/selectors";
import { load } from "./helpers";

function states(name: string): {
  events: ReturnType<typeof load>["events"];
  at: (i: number) => RunState;
  final: RunState;
} {
  const { events } = load(name);
  return { events, at: (i) => fold(events.slice(0, i)), final: fold(events) };
}

describe("happy-path", () => {
  const { events, at, final } = states("happy-path");

  it("plays to completion with three agents and the approved final commit", () => {
    expect(final.run).toMatchObject({ status: "completed", finalCommit: "b4e5f6a" });
    expect(final.agentOrder).toHaveLength(3);
    const result = selectResult(final);
    expect(result.outcome).toBe("T1 reviewed and approved on task/T1 at b4e5f6a");
    expect(result.latestVerification).toMatchObject({
      passed: true,
      summary: "15 passed",
      agentId: "a_rev",
    });
    expect(Object.values(final.tasks).every((t) => t.status === "done")).toBe(true);
    expect(
      Object.values(final.agents).every(
        (a) => a.state === "stopped" && a.sandbox?.state === "terminated",
      ),
    ).toBe(true);
  });

  it("shows the peer link only from the first DM and thickens it with later DMs", () => {
    const firstDm = events.findIndex(
      (e) =>
        e.type === "message.sent" &&
        e.channelKind === "dm" &&
        e.from !== USER_ID &&
        !e.to.includes(USER_ID),
    );
    const team = events.findIndex((e) => e.type === "message.sent" && e.channelKind === "team");
    expect(team).toBeLessThan(firstDm);
    expect(at(firstDm).peerLinks).toEqual({});
    expect(at(firstDm + 1).peerLinks["a_impl|a_rev"]?.count).toBe(1);
    expect(final.peerLinks["a_impl|a_rev"]?.count).toBe(3);
    // The reviewer's team mention to the orchestrator creates no link.
    expect(Object.keys(final.peerLinks)).toEqual(["a_impl|a_rev"]);
  });

  it("builds the handoff: rejected commit, fix, approval", () => {
    const t1 = selectHandoff(final).find((h) => h.task.id === "T1")!;
    const verifies = t1.entries.filter((e) => e.kind === "verify").map((e) => [e.commit, e.passed]);
    expect(verifies).toContainEqual(["a1b2c3d", false]);
    expect(verifies.at(-1)).toEqual(["b4e5f6a", true]);
    expect(t1.entries.at(-1)!.text).toBe("done, marked by reviewer");
  });

  it("keeps #team high level and puts the detail in DMs", () => {
    const team = teamItems(events, final);
    const teamText = team
      .map((i) => (i.kind === "message" ? i.message.body : i.kind === "milestone" ? i.text : ""))
      .join("\n");
    expect(team.some((i) => i.kind === "activity")).toBe(false);
    expect(teamText).toContain("implementer joined");
    expect(teamText).toContain("T1 claimed by implementer");
    expect(teamText).not.toContain("npm test");
    const dm = dmItems(events, final, "a_impl|a_rev", true);
    const dmText = dm
      .map((i) => (i.kind === "activity" ? i.text : i.kind === "message" ? i.message.body : ""))
      .join("\n");
    expect(dm.filter((i) => i.kind === "message")).toHaveLength(3);
    expect(dmText).toContain("npm test on a1b2c3d failed");
    expect(dmText).toContain("woke on a dm from implementer");
    expect(dmItems(events, final, "a_impl|a_rev", false).every((i) => i.kind === "message")).toBe(
      true,
    );
  });

  it("opens and closes with the operator's DM to the orchestrator", () => {
    const key = userDmKey(final)!;
    expect(key).toBe("a_orch|user");
    const msgs = dmItems(events, final, key, false).flatMap((i) =>
      i.kind === "message" ? [i.message] : [],
    );
    expect(msgs.map((m) => m.from)).toEqual([USER_ID, "a_orch", "a_orch"]);
    expect(Object.keys(final.agents)).not.toContain(USER_ID);
  });

  it("drains every inbox", () => {
    expect(Object.values(final.agents).flatMap((a) => a.pendingDeliveries)).toEqual([]);
  });
});

describe("recovery", () => {
  const { events, at, final } = states("recovery");
  const idx = (pred: (e: (typeof events)[number]) => boolean) => events.findIndex(pred);

  it("shows a DM wake and a timer wake with a countdown", () => {
    const wakes = final.agents.a_rev!.wakes.map((w) => w.reason);
    expect(wakes).toEqual(["dm", "timer", "dm", "dm"]);
    const timerWake = idx((e) => e.type === "agent.woken" && e.reason === "timer");
    expect(at(timerWake).agents.a_rev!.wakeAt).toBeDefined();
    expect(at(timerWake + 2).agents.a_rev!.wakeAt).toBeUndefined();
  });

  it("records the Temporal worker restart and a single invocation afterwards", () => {
    expect(final.workerRestarts).toHaveLength(1);
    const restart = idx((e) => e.type === "worker.restarted");
    const after = events
      .slice(restart)
      .filter((e) => e.agentId === "a_rev" && e.type === "agent.woken");
    expect(after.length).toBeGreaterThan(0);
    const wakeIdx = events.indexOf(after[0]!);
    const runningInvocations = new Set(
      events
        .slice(
          wakeIdx,
          idx((e) => e.type === "sandbox.state" && e.state === "terminated"),
        )
        .flatMap((e) =>
          e.type === "agent.state" && e.agentId === "a_rev" && e.invocationId
            ? [e.invocationId]
            : [],
        ),
    );
    expect(runningInvocations.size).toBe(1);
  });

  it("changes sandbox ID and generation, and drains the waiting message", () => {
    const followUp = idx((e) => e.type === "message.sent" && e.body.startsWith("Follow-up"));
    const queued = at(followUp + 2);
    expect(queued.agents.a_rev).toMatchObject({ state: "recovering", generation: 2 });
    expect(queued.agents.a_rev!.pendingDeliveries).toHaveLength(1);
    expect(final.agents.a_rev!.pendingDeliveries).toHaveLength(0);
    expect(final.agents.a_rev!.sandbox).toMatchObject({ id: "sb-9d4", previousIds: ["sb-2c3"] });
    expect(final.agents.a_rev!.checkpointVersion).toBe(6);
    expect(final.sandboxReplacements).toHaveLength(1);
  });

  it("resolves the relay failure in place", () => {
    expect(Object.values(final.failures)).toEqual([
      expect.objectContaining({ scope: "relay", resolved: true }),
    ]);
  });
});

describe("third-worker", () => {
  const { at, events, final } = states("third-worker");

  it("fills the open slot without code changes", () => {
    const beforeSpawn = events.findIndex(
      (e) => e.type === "agent.spawned" && e.agentId === "a_spec",
    );
    const before = selectSlots(at(beforeSpawn));
    expect(before.count).toBe(4);
    expect(before.slots.filter((s) => !s.agentId)).toHaveLength(1);
    const after = selectSlots(final);
    expect(after.slots.every((s) => s.agentId)).toBe(true);
    expect(after.slots.map((s) => final.agents[s.agentId!]!.role)).toEqual([
      "orchestrator",
      "implementer",
      "reviewer",
      "specialist",
    ]);
  });

  it("lets the specialist DM the implementer and finish T2", () => {
    expect(final.peerLinks["a_impl|a_spec"]?.count).toBeGreaterThan(0);
    expect(final.tasks.T2).toMatchObject({
      status: "done",
      ownerId: "a_spec",
      resultCommit: "c7d8e9f",
    });
    expect(final.run).toMatchObject({ status: "completed", finalCommit: "c7d8e9f" });
  });
});

describe("edge-states", () => {
  const loaded = load("edge-states");
  const final = fold(loaded.events);

  it("covers every agent state", () => {
    const seen = new Set(Object.values(final.agents).map((a) => a.state));
    expect([...seen].sort()).toEqual([
      "checkpointing",
      "failed",
      "needs_inspection",
      "provisioning",
      "recovering",
      "running",
      "stopped",
      "waiting",
    ]);
  });

  it("has both failure styles, a blocked task with a dependency, and an agent without a sandbox", () => {
    const failures = Object.values(final.failures);
    expect(failures.some((f) => f.resolved)).toBe(true);
    expect(failures.some((f) => !f.resolved)).toBe(true);
    expect(final.tasks.T3).toMatchObject({ status: "blocked", dependsOn: ["T1"] });
    expect(final.agents.a_docs!.sandbox).toBeUndefined();
  });

  it("counts the unknown event and the malformed one", () => {
    expect(loaded.skipped).toBe(1);
    expect(unknownCount(loaded.events)).toBe(1);
  });
});
