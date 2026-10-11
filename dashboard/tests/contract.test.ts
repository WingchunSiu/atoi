import { describe, expect, it } from "vitest";
import { parseEvent } from "../src/contract/events";

const envelope = { seq: 1, ts: "2026-10-11T13:50:00.000Z", runId: "r_1" };

describe("parseEvent", () => {
  it("accepts a valid event and strips nothing it needs", () => {
    const r = parseEvent({
      ...envelope,
      type: "agent.woken",
      agentId: "a_rev",
      reason: "dm",
      causedBy: "m_1",
    });
    expect(r).toEqual({
      ok: true,
      event: { ...envelope, type: "agent.woken", agentId: "a_rev", reason: "dm", causedBy: "m_1" },
    });
  });

  it("keeps unknown types as 'unknown' instead of failing", () => {
    const r = parseEvent({ ...envelope, type: "agent.mood", agentId: "a_qa", mood: "curious" });
    expect(r.ok && r.event.type).toBe("unknown");
    expect(r.ok && r.event.type === "unknown" && r.event.originalType).toBe("agent.mood");
  });

  it("rejects a malformed envelope", () => {
    expect(parseEvent({ ...envelope, seq: -1, type: "worker.restarted" }).ok).toBe(false);
    expect(parseEvent({ ...envelope, ts: "yesterday", type: "worker.restarted" }).ok).toBe(false);
    expect(parseEvent({ seq: 1, ts: envelope.ts, type: "worker.restarted" }).ok).toBe(false);
    expect(parseEvent("not an object").ok).toBe(false);
  });

  it("rejects a known type with an invalid payload", () => {
    const r = parseEvent({ ...envelope, type: "message.sent", body: "missing fields" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("message.sent");
  });

  it("accepts timestamps with offsets", () => {
    expect(
      parseEvent({ ...envelope, ts: "2026-10-11T15:50:00+02:00", type: "worker.restarted" }).ok,
    ).toBe(true);
  });
});
