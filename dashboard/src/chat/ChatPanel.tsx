import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Outgoing, useRun, useRunSnapshot, useRunState, useUi } from "../app/context";
import { type AgentId, TERMINAL_RUN_STATUSES, USER_ID } from "../contract/events";
import {
  type ChatItem,
  dmItems,
  dmLabel,
  nameOf,
  type Tone,
  teamItems,
  userDmKey,
} from "../state/chat";
import { clock, shortClock } from "../state/format";
import type { Message, RunState } from "../state/reduce";
import type { RunSnapshot } from "../state/runStore";
import { useStore } from "../state/store";
import { AgentAvatar } from "../ui/AgentAvatar";
import { RichText } from "../ui/chips";
import { actions } from "../ui/uiStore";

const TONE: Record<Tone, string> = {
  default: "text-ink",
  muted: "text-muted",
  red: "text-red",
  amber: "text-amber",
  green: "text-green",
  accent: "text-accent",
};

const GROUP_MS = 3 * 60_000;

function Avatar({ id }: { id: AgentId }) {
  if (id === "harness") return <span className="text-chip text-muted">system</span>;
  if (id !== USER_ID) return <AgentAvatar id={id} size={36} />;
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-box bg-ink text-chip font-semibold text-card"
    >
      you
    </span>
  );
}

function SenderName({ id, state }: { id: AgentId; state: RunState }) {
  if (id === "harness") return <span className="text-chip text-muted">system</span>;
  if (id === USER_ID) return <span className="text-body font-semibold">you</span>;
  return (
    <button
      type="button"
      onClick={() => actions.selectAgent(id)}
      title={id}
      className="text-body font-semibold hover:underline"
    >
      {nameOf(state, id)}
    </button>
  );
}

const MessageRow = memo(function MessageRow({
  message,
  grouped,
  state,
}: {
  message: Message;
  grouped: boolean;
  state: RunState;
}) {
  return (
    <li className={`flex gap-3 px-4 ${grouped ? "pt-0.5" : "pt-3"}`}>
      {grouped ? <span className="w-9 shrink-0" /> : <Avatar id={message.from} />}
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <SenderName id={message.from} state={state} />
            <span className="text-chip text-muted" title={clock(message.ts)}>
              {shortClock(message.ts)}
            </span>
          </div>
        )}
        <p className="whitespace-pre-wrap break-words font-sans text-[15px] leading-[22px]">
          <RichText text={message.body} />
        </p>
      </div>
    </li>
  );
});

function MilestoneRow({ item }: { item: Extract<ChatItem, { kind: "milestone" }> }) {
  return (
    <li className="flex items-baseline gap-3 px-4 pt-2 text-chip">
      <span className="w-9 shrink-0 text-right text-muted">{shortClock(item.ts)}</span>
      <span className={`border-l-2 border-current pl-2 ${TONE[item.tone]}`}>
        <RichText text={item.text} />
      </span>
    </li>
  );
}

function ActivityRow({
  item,
  state,
  showName,
}: {
  item: Extract<ChatItem, { kind: "activity" }>;
  state: RunState;
  showName: boolean;
}) {
  return (
    <li className="flex items-baseline gap-3 px-4 pt-0.5 font-mono text-chip leading-[19px]">
      <span className="w-9 shrink-0 text-right text-muted" title={clock(item.ts)}>
        {shortClock(item.ts)}
      </span>
      <span className="min-w-0 flex-1 break-words">
        {showName && (
          <span className="mr-1.5 font-semibold text-ink">{nameOf(state, item.agentId)}</span>
        )}
        <span className={`mr-1.5 ${TONE[item.tone]}`} aria-hidden>
          {item.icon}
        </span>
        <span className={item.tone === "default" ? "text-muted" : TONE[item.tone]}>
          <RichText text={item.text} />
        </span>
      </span>
    </li>
  );
}

function PendingRow({
  item,
  onRetry,
  onDiscard,
}: {
  item: Outgoing;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <li className="flex gap-3 px-4 pt-3">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-box bg-ink text-chip font-semibold text-card opacity-60"
      >
        you
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-body font-semibold">you</span>
          {item.status === "failed" ? (
            <span className="text-chip text-red">not sent</span>
          ) : (
            <span className="text-chip text-muted">sending…</span>
          )}
        </div>
        <p className="whitespace-pre-wrap break-words font-sans text-[15px] leading-[22px] text-muted">
          {item.body}
        </p>
        {item.status === "failed" && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-chip">
            <span className="text-red">{item.error}</span>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-box border border-ink px-1.5 leading-[20px] hover:bg-hub"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onDiscard}
              className="rounded-box border border-line px-1.5 leading-[20px] hover:bg-hub"
            >
              Discard
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function Header({
  chat,
  state,
  userKey,
}: {
  chat: string | null;
  state: RunState;
  userKey?: string;
}) {
  const showActivity = useUi((u) => u.showActivity);
  if (!chat) {
    const agents = state.agentOrder.length;
    return (
      <header className="atoi-panel-header flex items-center gap-3 border-b-2 border-ink px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="atoi-label atoi-bullet text-lead font-semibold"># team</h2>
          <p
            className="truncate text-chip text-muted"
            title="Select an edge on the canvas to open that DM"
          >
            {agents} agent{agents === 1 ? "" : "s"} · team channel
          </p>
        </div>
        <select
          aria-label="Message recipient"
          value=""
          onChange={(e) => {
            if (e.target.value) actions.openChat([USER_ID, e.target.value].sort().join("|"));
          }}
          className="max-w-[140px] rounded-box border border-line bg-card p-1 text-chip"
        >
          <option value="">Message a peer</option>
          {state.agentOrder.map((id) => (
            <option key={id} value={id}>
              {state.agents[id]?.role}
            </option>
          ))}
        </select>
        {userKey && (
          <button
            type="button"
            onClick={() => actions.messageOrchestrator(userKey)}
            className="atoi-btn-primary shrink-0 rounded-box border-2 border-ink px-2 text-body leading-[28px] hover:bg-hub"
          >
            Message orchestrator
          </button>
        )}
      </header>
    );
  }
  const isUser = chat.split("|").includes(USER_ID);
  return (
    <header className="atoi-panel-header flex items-center gap-3 border-b-2 border-ink px-4 py-2.5">
      <button
        type="button"
        onClick={() => actions.openChat(null)}
        title="Back to #team (Esc)"
        aria-label="Back to #team"
        className="shrink-0 rounded-box border border-line px-2 text-title leading-[28px] hover:bg-hub"
      >
        ←
      </button>
      <div className="min-w-0 flex-1">
        <h2 className="atoi-label truncate text-title font-semibold" title={dmLabel(state, chat)}>
          {dmLabel(state, chat)}
        </h2>
        <p className="text-chip text-muted">
          {isUser ? "Your direct conversation with this agent" : "Direct messages"}
        </p>
      </div>
      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-chip">
        <input
          type="checkbox"
          checked={showActivity}
          onChange={actions.toggleActivity}
          className="accent-[var(--color-ink)]"
        />
        activity
      </label>
    </header>
  );
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function Composer({ state, orchestrator }: { state: RunState; orchestrator: AgentId }) {
  const { source, outbox } = useRun();
  const focusTick = useUi((u) => u.focusComposer);
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusTick) area.current?.focus();
  }, [focusTick]);

  const orch = state.agents[orchestrator];
  const runOver =
    state.run &&
    (TERMINAL_RUN_STATUSES.has(state.run.status) ||
      ["completing", "stopping"].includes(state.run.status));
  const blocked = runOver
    ? `The run is ${state.run!.status}. Start a new run to give more instructions.`
    : orch && (orch.state === "stopped" || orch.state === "failed")
      ? `The orchestrator has ${orch.state === "stopped" ? "stopped" : "failed"}.`
      : undefined;

  const submit = async () => {
    const body = text.trim();
    if (!body || blocked) return;
    const item: Outgoing = {
      clientRequestId: newRequestId(),
      to: orchestrator,
      body,
      ts: new Date().toISOString(),
      status: "sending",
    };
    outbox.set((o) => ({ items: [...o.items, item] }));
    setText("");
    const result = await source.send({
      to: orchestrator,
      body,
      clientRequestId: item.clientRequestId,
    });
    if (!result.ok) {
      outbox.set((o) => ({
        items: o.items.map((i) =>
          i.clientRequestId === item.clientRequestId
            ? { ...i, status: "failed", error: result.error }
            : i,
        ),
      }));
    }
  };

  return (
    <form
      className="border-t-2 border-ink p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {blocked ? (
        <p className="text-body text-muted">{blocked}</p>
      ) : (
        <div className="flex items-end gap-2">
          <textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={Math.min(6, Math.max(2, text.split("\n").length))}
            placeholder={
              orchestrator
                ? `Message ${orch?.role ?? "agent"}`
                : "Message the team · orchestrator will respond"
            }
            aria-label={orchestrator ? "Message agent" : "Team message"}
            className="min-w-0 flex-1 resize-none rounded-box border-2 border-ink bg-paper px-2.5 py-1.5 font-sans text-[15px] leading-[22px] text-ink placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="atoi-btn-primary rounded-box border-2 border-ink bg-ink px-3 text-body leading-[30px] text-card disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-muted"
          >
            Send
          </button>
        </div>
      )}
      {!blocked && source.mock && (
        <p className="mt-1.5 text-chip text-muted">
          Mock run: the orchestrator's reply is scripted.
        </p>
      )}
    </form>
  );
}

const selectEvents = (s: RunSnapshot) => s.events;

export function ChatPanel() {
  const { source, outbox } = useRun();
  const chat = useUi((u) => u.chat);
  const showActivity = useUi((u) => u.showActivity);
  const events = useRunSnapshot(selectEvents);
  const state = useRunState();
  const userKey = userDmKey(state);
  const isUserDm = !!chat && chat.split("|").includes(USER_ID);
  const recipient = isUserDm ? chat!.split("|").find((id) => id !== USER_ID) : undefined;
  const pending = useStore(outbox, (o) => o.items);

  const items = useMemo(
    () => (chat ? dmItems(events, state, chat, showActivity) : teamItems(events, state)),
    [chat, events, state, showActivity],
  );

  // Drop outgoing messages once the backend's event for them arrives.
  const echoed = useMemo(
    () => new Set(state.messages.flatMap((m) => (m.clientRequestId ? [m.clientRequestId] : []))),
    [state.messages],
  );
  useEffect(() => {
    if (pending.some((p) => echoed.has(p.clientRequestId))) {
      outbox.set((o) => ({ items: o.items.filter((p) => !echoed.has(p.clientRequestId)) }));
    }
  }, [echoed, pending, outbox]);
  const visiblePending = pending.filter(
    (p) => !echoed.has(p.clientRequestId) && p.to === (recipient ?? ""),
  );

  const retry = useCallback(
    async (item: Outgoing) => {
      outbox.set((o) => ({
        items: o.items.map((i) => (i === item ? { ...i, status: "sending", error: undefined } : i)),
      }));
      const result = await source.send({
        to: item.to,
        body: item.body,
        clientRequestId: item.clientRequestId,
      });
      if (!result.ok) {
        outbox.set((o) => ({
          items: o.items.map((i) =>
            i.clientRequestId === item.clientRequestId
              ? { ...i, status: "failed", error: result.error }
              : i,
          ),
        }));
      }
    },
    [outbox, source],
  );

  // Stick to the newest message unless the reader has scrolled up.
  const list = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(false);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (pinned) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [items.length, visiblePending.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
    setUnseen(false);
  }, [chat]);
  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
    setPinned(atBottom);
    if (atBottom) setUnseen(false);
  };

  const pairNames = chat ? dmLabel(state, chat) : "";
  const empty = !items.length && !visiblePending.length;

  return (
    <section
      aria-label="chat"
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l-2 border-ink bg-card max-lg:border-l-0 max-lg:border-t-2"
    >
      <Header chat={chat} state={state} userKey={userKey} />
      <div className="relative min-h-0 flex-1">
        <div
          ref={list}
          onScroll={onScroll}
          className="h-full overflow-y-auto pb-3"
          aria-live="polite"
        >
          {empty && (
            <p className="px-4 pt-4 text-body text-muted">
              {!chat
                ? "No team messages yet."
                : isUserDm
                  ? "Send the orchestrator a message. It reads it the next time it wakes."
                  : `No messages between ${pairNames} yet.`}
            </p>
          )}
          <ol>
            {items.map((item, i) => {
              const prev = items[i - 1];
              if (item.kind === "message") {
                const grouped =
                  prev?.kind === "message" &&
                  prev.message.from === item.message.from &&
                  Date.parse(item.ts) - Date.parse(prev.ts) < GROUP_MS;
                return (
                  <MessageRow
                    key={item.key}
                    message={item.message}
                    grouped={grouped}
                    state={state}
                  />
                );
              }
              if (item.kind === "response")
                return (
                  <li key={item.key} className="flex gap-3 px-4 pt-3">
                    <Avatar id={item.agentId} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <SenderName id={item.agentId} state={state} />
                        <span className="text-chip text-muted">
                          {shortClock(item.ts)} · agent output
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap break-words font-sans text-[15px] leading-[22px]">
                        <RichText text={item.text} />
                      </p>
                    </div>
                  </li>
                );
              if (item.kind === "milestone") return <MilestoneRow key={item.key} item={item} />;
              const showName = !(prev?.kind === "activity" && prev.agentId === item.agentId);
              return <ActivityRow key={item.key} item={item} state={state} showName={showName} />;
            })}
            {visiblePending.map((p) => (
              <PendingRow
                key={p.clientRequestId}
                item={p}
                onRetry={() => void retry(p)}
                onDiscard={() => outbox.set((o) => ({ items: o.items.filter((i) => i !== p) }))}
              />
            ))}
          </ol>
        </div>
        {unseen && !pinned && (
          <button
            type="button"
            onClick={() => {
              const el = list.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-box border-2 border-ink bg-card px-2 text-chip leading-[24px] hover:bg-hub"
          >
            New activity ↓
          </button>
        )}
      </div>
      {(isUserDm || !chat) &&
        state.agentOrder.some(
          (id) =>
            (!recipient || id === recipient) &&
            ["running", "provisioning", "checkpointing"].includes(state.agents[id]?.state ?? ""),
        ) && (
          <p role="status" className="px-4 py-2 text-chip text-muted">
            {recipient ? nameOf(state, recipient) : "Team"} is working…
          </p>
        )}
      {(isUserDm || !chat) && <Composer state={state} orchestrator={recipient ?? ""} />}
    </section>
  );
}
