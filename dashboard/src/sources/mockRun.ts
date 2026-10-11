// Streams a scripted fixture as if it were a live run, and stands in for the backend's
// message endpoint. Used in the browser (?source=mock) and by scripts/fake-sse.ts.
//
// Like a real backend, it assigns `seq` and `ts` as each event is written, so messages the
// operator sends interleave correctly with the scripted events. Replies to the operator are
// scripted and say so in their text.
import {
  type RunStatus,
  type SendMessageRequest,
  TERMINAL_RUN_STATUSES,
  USER_ID,
} from "../contract/events";
import type { SendResult } from "./types";

export type RawEvent = Record<string, unknown> & { type: string };
type Written = RawEvent & { seq: number; ts: string; runId: string };

const MAX_GAP_MS = 1200;
const MIN_GAP_MS = 40;

export class MockRun {
  readonly runId: string;
  readonly events: Written[] = [];
  private listeners = new Set<(e: Written) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private seq = 0;
  private index = 0;
  private started = false;
  private sentByRequest = new Map<string, string>();
  private userMessages = 0;
  private orchestrator?: { id: string; generation: number; state: string; invocationId?: string };
  private status?: RunStatus;

  constructor(
    private readonly script: RawEvent[],
    private readonly speed = 1,
  ) {
    this.runId = String(script[0]?.runId ?? "r_mock");
  }

  onEvent(listener: (e: Written) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get runStatus(): RunStatus | undefined {
    return this.status;
  }

  get objective(): string | undefined {
    const e = this.script.find((x) => x.type === "run.state" && typeof x.objective === "string");
    return e?.objective as string | undefined;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.next();
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** Write an event now: assign seq and ts, rebase any wakeAt, and track run facts. */
  private write(payload: RawEvent, scriptedTs?: string): Written {
    const now = Date.now();
    const { seq: _seq, ts: _ts, runId: _runId, ...rest } = payload;
    const out: Written = {
      ...rest,
      seq: ++this.seq,
      ts: new Date(now).toISOString(),
      runId: this.runId,
    };
    if (typeof payload.wakeAt === "string" && scriptedTs) {
      out.wakeAt = new Date(
        now + (Date.parse(payload.wakeAt) - Date.parse(scriptedTs)),
      ).toISOString();
    }
    if (out.type === "run.state" && typeof out.status === "string")
      this.status = out.status as RunStatus;
    if (out.type === "agent.spawned" && out.kind === "orchestrator") {
      this.orchestrator = { id: String(out.agentId), generation: 0, state: "provisioning" };
    }
    if (out.type === "agent.state" && this.orchestrator && out.agentId === this.orchestrator.id) {
      this.orchestrator = {
        ...this.orchestrator,
        generation: Number(out.generation),
        state: String(out.state),
        invocationId: typeof out.invocationId === "string" ? out.invocationId : undefined,
      };
    }
    this.events.push(out);
    for (const l of this.listeners) l(out);
    return out;
  }

  private next = () => {
    const e = this.script[this.index];
    if (!e) return;
    this.write(e, typeof e.ts === "string" ? e.ts : undefined);
    this.index += 1;
    const following = this.script[this.index];
    if (!following) return;
    const gap = Math.max(0, Date.parse(String(following.ts)) - Date.parse(String(e.ts)));
    this.later(Math.max(MIN_GAP_MS, Math.min(gap, MAX_GAP_MS) / this.speed), this.next);
  };

  /** Stand-in for POST /api/runs/:runId/messages. */
  send(req: SendMessageRequest): SendResult {
    const known = this.sentByRequest.get(req.clientRequestId);
    if (known) return { ok: true, messageId: known };
    const orch = this.orchestrator;
    if (!orch || req.to !== orch.id)
      return { ok: false, status: 404, error: "The orchestrator isn't running yet." };
    if (this.status && TERMINAL_RUN_STATUSES.has(this.status)) {
      return { ok: false, status: 409, error: `The run is ${this.status}.` };
    }
    const n = ++this.userMessages;
    const messageId = `m_user_${n}`;
    this.sentByRequest.set(req.clientRequestId, messageId);
    const channelId = `dm:${[orch.id, USER_ID].sort().join("|")}`;
    this.write({
      type: "message.sent",
      messageId,
      channelId,
      channelKind: "dm",
      from: USER_ID,
      to: [orch.id],
      body: req.body,
      clientRequestId: req.clientRequestId,
    });
    const deliveryId = `d_user_${n}`;
    this.write({ type: "delivery.queued", agentId: orch.id, deliveryId, messageId });

    // The scripted orchestrator reads the DM and replies. If it's idle when the wake fires, it
    // runs its own invocation for that; if the fixture has it busy, it replies from within the
    // fixture's invocation and leaves that invocation's state alone.
    const invocationId = `inv_mock_${n}`;
    let woke = false;
    this.later(700, () => {
      const current = this.orchestrator!;
      if (current.state !== "running" && current.state !== "checkpointing") {
        woke = true;
        this.write({ type: "agent.woken", agentId: orch.id, reason: "dm", causedBy: messageId });
        this.write({
          type: "agent.state",
          agentId: orch.id,
          state: "running",
          generation: current.generation,
          invocationId,
        });
      }
      this.write({
        type: "tool.called",
        agentId: orch.id,
        tool: "read_channel",
        summary: "dm with you, 1 message",
        invocationId: woke ? invocationId : current.invocationId,
      });
    });
    this.later(2400, () => {
      const excerpt = req.body.replace(/\s+/g, " ").slice(0, 80);
      this.write({
        type: "message.sent",
        agentId: orch.id,
        messageId: `m_orch_reply_${n}`,
        channelId,
        channelKind: "dm",
        from: orch.id,
        to: [USER_ID],
        replyTo: messageId,
        body: `[mock reply] This is a scripted stand-in for the orchestrator. A live one would plan your message ("${excerpt}${req.body.length > 80 ? "…" : ""}") into tasks for the team.`,
      });
      this.write({ type: "delivery.done", agentId: orch.id, deliveryId, messageId });
      // Only end the invocation this reply started. If the script has changed the
      // orchestrator's state since (for example it began its own invocation), leave it.
      const current = this.orchestrator;
      if (woke && current?.state === "running" && current.invocationId === invocationId) {
        this.write({
          type: "agent.state",
          agentId: orch.id,
          state: "waiting",
          generation: current.generation,
        });
      }
    });
    return { ok: true, messageId };
  }
}
