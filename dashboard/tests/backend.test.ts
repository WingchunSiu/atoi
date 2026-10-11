import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEvent, USER_ID } from "../src/contract/events";
import {
  type BackendSnapshot,
  emptyBackendState,
  participant,
  projectActivity,
  snapshotSchema,
} from "../src/sources/backend";
import { LiveSource } from "../src/sources/live";
import { dmItems, teamItems } from "../src/state/chat";
import { reduce } from "../src/state/reduce";

const now = "2026-10-11T23:20:00Z";
const snapshot: BackendSnapshot = snapshotSchema.parse({
  run: {
    _id: "run",
    objective: "Help plan tomorrow",
    workerLimit: 2,
    status: "active",
    createdAt: now,
  },
  agents: [
    {
      _id: "planner",
      role: "orchestrator",
      kind: "orchestrator",
      status: "idle",
      generation: 1,
      createdAt: now,
    },
  ],
  tasks: [],
  channels: [],
  messages: [],
  invocations: [],
});
afterEach(() => vi.unstubAllGlobals());

describe("live browser coordination", () => {
  it("addresses plain human team messages to the actual orchestrator", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ _id: "message" })));
    vi.stubGlobal("fetch", fetchMock);
    const source = new LiveSource("run");
    expect(await source.send({ to: "", body: "hello", clientRequestId: "request" })).toEqual({
      ok: true,
      messageId: "message",
    });
    const [url, options] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/runs/run/messages");
    expect(JSON.parse(options.body)).toEqual({
      requestId: "request",
      body: "hello",
      mentions: ["planner"],
    });
    expect(options.headers["x-atoi-browser"]).toBe("1");
  });

  it("never silently sends an unaddressed request when no planner exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ...snapshot, agents: [] })));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await new LiveSource("run").send({ to: "", body: "hello", clientRequestId: "request" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("orchestrator is not available") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps direct requests addressed only to the selected peer and exposes backend rejection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: "The run has ended" }), { status: 409 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await new LiveSource("run").send({ to: "peer", body: "hello", clientRequestId: "request" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("run has ended") });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      requestId: "request",
      body: "hello",
      recipientId: "peer",
      mentions: [],
    });
  });

  it("shows recorded Pi text in chat even when tool activity is hidden", () => {
    const projected = projectActivity(
      {
        _id: "event",
        runId: "run",
        entityId: "invocation",
        agentId: "planner",
        generation: 1,
        sequence: 12,
        createdAt: now,
        type: "message_end",
        payload: {
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private" },
              { type: "text", text: "Here is your plan." },
            ],
          },
        },
      },
      snapshot,
    );
    expect(projected).toHaveLength(1);
    expect(parseEvent(projected[0]).ok).toBe(true);
    const state = reduce(emptyBackendState("run"), projected[0]!);
    expect(dmItems(projected, state, [USER_ID, "planner"].sort().join("|"), false)).toMatchObject([
      { kind: "response", agentId: "planner", text: "Here is your plan." },
    ]);
    expect(teamItems(projected, state)).toMatchObject([
      { kind: "response", text: "Here is your plan." },
    ]);
    expect(dmItems(projected, state, "peer|planner", false)).toEqual([]);
  });

  it("distinguishes internal harness notices from the human", () => {
    expect(participant("operator")).toBe(USER_ID);
    expect(participant("harness")).toBe("harness");
    const state = reduce(emptyBackendState("run"), {
      seq: 1,
      ts: now,
      runId: "run",
      type: "message.sent",
      messageId: "notice",
      channelId: "team",
      channelKind: "team",
      from: "harness",
      to: ["planner"],
      body: "Task updated",
    });
    expect(state.agentOrder).toEqual(["planner"]);
    expect(state.messages[0]?.from).toBe("harness");
  });
});
