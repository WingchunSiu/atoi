// Builds scripted mock runs. The builder assigns seq, runId and ts from a start time plus a
// running offset, and has helpers for the event combinations every fixture repeats.
import {
  type AgentId,
  type AgentState,
  type RunEvent,
  type SandboxState,
  type Task,
  USER_ID,
  type WakeReason,
} from "../src/contract/events";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Payload = DistributiveOmit<RunEvent, "seq" | "ts" | "runId">;

export interface Fixture {
  name: string;
  events: unknown[];
}

export function fixture(opts: { runId: string; start: string }) {
  let t = Date.parse(opts.start);
  let seq = 0;
  let messages = 0;
  let deliveries = 0;
  let invocations = 0;
  let rand = 7;
  const events: unknown[] = [];
  const generation = new Map<AgentId, number>();
  const invocation = new Map<AgentId, string>();
  const tasks = new Map<string, Task>();

  // Small deterministic PRNG so fixtures are byte-for-byte stable.
  const random = () => {
    rand = (rand * 1103515245 + 12345) % 2147483648;
    return rand / 2147483648;
  };

  const now = () => new Date(t).toISOString();

  /** Emit one event `sec` seconds after the previous one. */
  function after(sec: number, payload: Payload): number {
    t += Math.round(sec * 1000);
    seq += 1;
    events.push({ seq, ts: now(), runId: opts.runId, ...payload });
    return seq;
  }

  /** Emit a raw, possibly invalid, object. Used to test unknown and malformed events. */
  function raw(sec: number, payload: Record<string, unknown>) {
    t += Math.round(sec * 1000);
    seq += 1;
    events.push({ seq, ts: now(), runId: opts.runId, ...payload });
  }

  function gen(agentId: AgentId) {
    return generation.get(agentId) ?? 0;
  }

  function state(
    sec: number,
    agentId: AgentId,
    s: AgentState,
    extra: { generation?: number; wakeAt?: string; detail?: string } = {},
  ) {
    if (extra.generation !== undefined) generation.set(agentId, extra.generation);
    const g = gen(agentId);
    const invocationId =
      s === "running" || s === "checkpointing" ? invocation.get(agentId) : undefined;
    after(sec, {
      type: "agent.state",
      agentId,
      state: s,
      generation: g,
      invocationId,
      wakeAt: extra.wakeAt,
      detail: extra.detail,
    });
  }

  /** Spawn an agent. `spawnedBy` is omitted for the CLI-launched orchestrator. */
  function spawn(
    sec: number,
    agentId: AgentId,
    role: string,
    kind: "orchestrator" | "worker",
    spawnedBy?: AgentId,
  ) {
    generation.set(agentId, 0);
    after(sec, {
      type: "agent.spawned",
      agentId,
      role,
      kind,
      spawnedBy,
      causedBy: spawnedBy ? invocation.get(spawnedBy) : undefined,
    });
  }

  function sandbox(sec: number, agentId: AgentId, s: SandboxState, sandboxId: string) {
    after(sec, { type: "sandbox.state", agentId, state: s, sandboxId });
  }

  /** Provision an agent: sandbox starting → running, then the first state at generation 1. */
  function provision(
    sec: number,
    agentId: AgentId,
    sandboxId: string,
    then: AgentState = "waiting",
  ) {
    sandbox(sec, agentId, "starting", sandboxId);
    sandbox(4 + random() * 3, agentId, "running", sandboxId);
    if (then === "running") invocation.set(agentId, `inv_${++invocations}`);
    state(0.5, agentId, then, { generation: 1 });
  }

  function message(
    sec: number,
    m: { from: AgentId; to: AgentId[]; body: string; channelKind: "team" | "dm"; replyTo?: string },
  ) {
    const messageId = `m_${++messages}`;
    const channelId =
      m.channelKind === "team" ? "team" : `dm:${[m.from, ...m.to].sort().join("|")}`;
    const fromUser = m.from === USER_ID;
    after(sec, {
      type: "message.sent",
      agentId: fromUser ? undefined : m.from,
      messageId,
      channelId,
      channelKind: m.channelKind,
      from: m.from,
      to: m.to,
      body: m.body,
      replyTo: m.replyTo,
      causedBy: invocation.get(m.from),
    });
    const ids: Record<AgentId, string> = {};
    // The operator has no inbox; only agents get deliveries.
    for (const to of m.to.filter((t) => t !== USER_ID)) {
      const deliveryId = `d_${++deliveries}`;
      ids[to] = deliveryId;
      after(0.2, { type: "delivery.queued", agentId: to, deliveryId, messageId });
    }
    return { messageId, deliveries: ids };
  }

  /** A DM plus the recipient's delivery (none when the recipient is the operator). */
  function dm(sec: number, m: { from: AgentId; to: AgentId; body: string; replyTo?: string }) {
    const sent = message(sec, {
      from: m.from,
      to: [m.to],
      body: m.body,
      channelKind: "dm",
      replyTo: m.replyTo,
    });
    return { messageId: sent.messageId, deliveryId: sent.deliveries[m.to] ?? "" };
  }

  /** A team-channel message. `mentions` become addressed deliveries. */
  function team(sec: number, m: { from: AgentId; body: string; mentions?: AgentId[] }) {
    return message(sec, { from: m.from, to: m.mentions ?? [], body: m.body, channelKind: "team" });
  }

  /** Wake an agent and start a new invocation. `causedBy` is a message ID or a timer ID. */
  function wake(sec: number, agentId: AgentId, reason: WakeReason, causedBy: string) {
    invocation.set(agentId, `inv_${++invocations}`);
    after(sec, { type: "agent.woken", agentId, reason, causedBy });
    state(0.3, agentId, "running");
  }

  function tool(sec: number, agentId: AgentId, name: string, summary: string) {
    after(sec, {
      type: "tool.called",
      agentId,
      tool: name,
      summary,
      invocationId: invocation.get(agentId),
    });
  }

  function done(sec: number, agentId: AgentId, deliveryId: string, messageId: string) {
    after(sec, { type: "delivery.done", agentId, deliveryId, messageId });
  }

  function checkpoint(
    sec: number,
    agentId: AgentId,
    version: number,
    action: "saved" | "restored" = "saved",
  ) {
    if (action === "saved") {
      state(sec, agentId, "checkpointing");
      sec = 0.8;
    }
    after(sec, { type: "checkpoint", agentId, action, version });
  }

  /** Report usage for the agent's current invocation with plausible numbers. */
  function usage(sec: number, agentId: AgentId) {
    const total = 4000 + Math.round(random() * 16000);
    const input = Math.round(total * 0.82);
    after(sec, {
      type: "usage",
      agentId,
      invocationId: invocation.get(agentId),
      model: "claude-sonnet-5-5",
      inputTokens: input,
      outputTokens: total - input,
      costUsd: Math.round((0.01 + random() * 0.05) * 1000) / 1000,
      durationMs: 8000 + Math.round(random() * 40000),
    });
  }

  /** Finish the current invocation: usage, then waiting (optionally with a timer). */
  function sleep(sec: number, agentId: AgentId, extra: { wakeAt?: string; detail?: string } = {}) {
    usage(sec, agentId);
    state(0.3, agentId, "waiting", extra);
    invocation.delete(agentId);
  }

  function task(sec: number, agentId: AgentId | undefined, next: Task) {
    tasks.set(next.id, next);
    after(sec, { type: "task.upserted", agentId, taskId: next.id, task: next });
  }

  /** Upsert a task with a few fields changed. */
  function updateTask(sec: number, agentId: AgentId | undefined, id: string, patch: Partial<Task>) {
    const prev = tasks.get(id);
    if (!prev) throw new Error(`fixture: unknown task ${id}`);
    task(sec, agentId, { ...prev, ...patch });
  }

  function push(sec: number, agentId: AgentId, branch: string, commit: string, message: string) {
    after(sec, { type: "git.pushed", agentId, branch, commit, message });
  }

  function verify(
    sec: number,
    agentId: AgentId,
    commit: string,
    command: string,
    passed: boolean,
    summary: string,
  ) {
    after(sec, { type: "verification.recorded", agentId, commit, command, passed, summary });
  }

  return {
    after,
    raw,
    state,
    spawn,
    sandbox,
    provision,
    dm,
    team,
    wake,
    tool,
    done,
    checkpoint,
    usage,
    sleep,
    task,
    updateTask,
    push,
    verify,
    /** Current fixture time, for computing `wakeAt`. */
    at: (offsetSec = 0) => new Date(t + offsetSec * 1000).toISOString(),
    events: () => events,
  };
}

export type FixtureBuilder = ReturnType<typeof fixture>;

export const REPO = "atoi-demo/csv-parser";
export const OBJECTIVE = "Handle quoted newlines in the CSV parser";

export const T1: Task = {
  id: "T1",
  title: "Handle quoted newlines in CSV fields",
  description:
    "parse() splits rows on every newline, including newlines inside quoted fields. Keep quoted newlines inside the field.",
  acceptance: [`parse('"a\\nb",c') returns [['a\\nb', 'c']]`, "existing tests still pass"],
  status: "open",
};

export const T2: Task = {
  id: "T2",
  title: "Add a regression test for CRLF inside quoted fields",
  description: "Cover \\r\\n inside a quoted field so the CRLF case can't regress.",
  acceptance: ["parse_crlf_quoted test exists and passes"],
  status: "open",
};
