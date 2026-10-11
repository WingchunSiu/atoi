import { useRunState } from "../app/context";
import { USER_ID } from "../contract/events";
import { dmLabel, dmMessages, userDmKey } from "../state/chat";
import { clock, duration, firstLine, tokens, usd } from "../state/format";
import { AgentAvatar } from "../ui/AgentAvatar";
import { AgentChip, AgentStateMarker, SectionTitle, TaskChip } from "../ui/chips";
import { actions } from "../ui/uiStore";

export function AgentDetail({ id }: { id: string }) {
  const state = useRunState();
  const agent = state.agents[id];
  if (!agent)
    return (
      <p className="text-body text-muted">
        Agent {id} hasn't appeared yet at this point in the run.
      </p>
    );
  const inbox = agent.pendingDeliveries.map((d) => {
    const delivery = state.deliveries[d];
    return {
      id: d,
      message: delivery ? state.messages.find((m) => m.id === delivery.messageId) : undefined,
    };
  });
  const owned = Object.values(state.tasks).filter((t) => t.ownerId === id);
  const userKey = userDmKey(state);
  const conversations = [
    ...(agent.kind === "orchestrator" && userKey ? [userKey] : []),
    ...Object.values(state.peerLinks)
      .filter((l) => l.a === id || l.b === id)
      .map((l) => l.key),
  ];

  return (
    <div className="space-y-1 text-body">
      <div className="mb-2 flex items-center gap-3">
        <AgentAvatar id={agent.id} size={64} />
        <div>
          <h2 className="text-lead font-semibold">{agent.role}</h2>
          <span className="text-muted">{agent.kind}</span>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
        <dt className="text-muted">id</dt>
        <dd>{agent.id}</dd>
        <dt className="text-muted">state</dt>
        <dd>
          <AgentStateMarker state={agent.state} />
        </dd>
        <dt className="text-muted">generation</dt>
        <dd>{agent.generation}</dd>
        {agent.spawnedBy && (
          <>
            <dt className="text-muted">spawned by</dt>
            <dd>
              <AgentChip id={agent.spawnedBy} />
            </dd>
          </>
        )}
        {agent.checkpointVersion !== undefined && (
          <>
            <dt className="text-muted">checkpoint</dt>
            <dd>v{agent.checkpointVersion}</dd>
          </>
        )}
        {agent.sandbox && (
          <>
            <dt className="text-muted">sandbox</dt>
            <dd>
              {agent.sandbox.id} {agent.sandbox.state}
            </dd>
            {agent.sandbox.previousIds.length > 0 && (
              <>
                <dt className="text-muted">previous</dt>
                <dd className="text-muted">{agent.sandbox.previousIds.join(", ")}</dd>
              </>
            )}
          </>
        )}
      </dl>

      <SectionTitle>conversations</SectionTitle>
      {conversations.length === 0 ? (
        <p className="text-muted">No DMs yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {conversations.map((key) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => actions.openChat(key)}
                className="rounded-box border border-ink px-2 leading-[26px] hover:bg-hub"
              >
                {dmLabel(state, key)}{" "}
                <span className="text-muted">{dmMessages(state, key).length}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>inbox</SectionTitle>
      {inbox.length === 0 ? (
        <p className="text-muted">Nothing pending.</p>
      ) : (
        <ul className="space-y-1">
          {inbox.map(({ id: d, message }) => (
            <li key={d}>
              ✉{" "}
              {message ? (
                <>
                  {message.from === USER_ID ? <span>you</span> : <AgentChip id={message.from} />}{" "}
                  <span className="font-sans">{firstLine(message.body, 80)}</span>
                </>
              ) : (
                <span className="text-muted">{d}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>owned tasks</SectionTitle>
      {owned.length === 0 ? (
        <p className="text-muted">None.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {owned.map((t) => (
            <li key={t.id}>
              <TaskChip id={t.id} />
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>state history</SectionTitle>
      <ol className="space-y-0.5">
        {agent.stateHistory
          .slice()
          .reverse()
          .map((h) => (
            <li key={h.seq} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-muted">{clock(h.ts)}</span>
              <AgentStateMarker state={h.state} />
              {h.generation > 1 && <span className="text-muted">gen {h.generation}</span>}
              {h.detail && <span className="font-sans text-muted">{h.detail}</span>}
            </li>
          ))}
      </ol>

      <SectionTitle>wakes</SectionTitle>
      {agent.wakes.length === 0 ? (
        <p className="text-muted">None yet.</p>
      ) : (
        <ol className="space-y-0.5">
          {agent.wakes
            .slice()
            .reverse()
            .map((w) => {
              const cause = w.causedBy
                ? state.messages.find((m) => m.id === w.causedBy)
                : undefined;
              return (
                <li key={w.seq}>
                  <span className="mr-2 text-muted">{clock(w.ts)}</span>
                  {w.reason === "timer" ? (
                    "⏱ timer"
                  ) : (
                    <>
                      {w.reason === "dm" ? "✉ dm" : "@ mention"} from{" "}
                      {cause ? (
                        cause.from === USER_ID ? (
                          "you"
                        ) : (
                          <AgentChip id={cause.from} />
                        )
                      ) : (
                        "unknown"
                      )}
                    </>
                  )}
                </li>
              );
            })}
        </ol>
      )}

      <SectionTitle>tool calls</SectionTitle>
      {agent.tools.length === 0 ? (
        <p className="text-muted">None yet.</p>
      ) : (
        <ol className="space-y-0.5">
          {agent.tools
            .slice()
            .reverse()
            .map((t) => (
              <li key={t.seq} className="truncate" title={`${t.tool}: ${t.summary}`}>
                <span className="mr-2 text-muted">{clock(t.ts)}</span>
                {t.tool}: {t.summary}
              </li>
            ))}
        </ol>
      )}

      <SectionTitle>usage</SectionTitle>
      <p>
        {tokens(agent.usage.inputTokens)} in, {tokens(agent.usage.outputTokens)} out,{" "}
        {usd(agent.usage.costUsd)}, active {duration(agent.usage.durationMs)}
      </p>
    </div>
  );
}
