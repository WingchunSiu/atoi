import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Activity, watchActivity } from "../../src/client/activity.js";
import "./style.css";

interface Run {
  _id: string;
  objective: string;
  status: string;
}
interface Agent {
  _id: string;
  role: string;
  status: string;
  generation: number;
  turns: number;
}
interface Task {
  _id: string;
  description: string;
  status: string;
  result?: { commit: string; verification: string };
  review?: { commit: string; verification: string };
}
interface Detail {
  agent: Agent;
  tasks: Task[];
  lastActivity: Activity | null;
}
interface Team {
  run: Run;
  agents: Agent[];
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const label = (value: string) => value.replaceAll("_", " ");
function content(event: Activity) {
  const data = object(event.payload);
  if (event.type === "work_log") return text(data.note);
  if (event.type === "message_update") return text(data.text);
  const message = object(data.message);
  if (Array.isArray(message.content))
    return message.content
      .map((part) => text(object(part).text))
      .filter(Boolean)
      .join("\n");
  return "";
}
function title(event: Activity) {
  const data = object(event.payload);
  if (event.type.startsWith("tool_execution"))
    return `${text(data.toolName)} · ${event.type.endsWith("start") ? "started" : event.type.endsWith("end") ? (data.isError ? "failed" : "finished") : "output"}`;
  return (
    (
      {
        invocation_started: "Started a turn",
        invocation_finished: "Turn checkpointed",
        invocation_uncertain: "Needs inspection",
        work_log: "Working note",
        message_start: "Message started",
        message_update: "Writing a response",
        message_end: "Message",
      } as Record<string, string>
    )[event.type] ?? label(event.type)
  );
}
function EventCard({ event }: { event: Activity }) {
  const data = object(event.payload);
  const isLog = event.type === "work_log";
  const body = content(event);
  return (
    <article className="rounded-xl border border-[#e3e8de] bg-white p-5">
      <div className="flex items-center justify-between gap-4 text-xs text-[#738174]">
        <span className="font-medium uppercase tracking-wider">{title(event)}</span>
        <time dateTime={event.createdAt}>
          {new Date(event.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </time>
      </div>
      {body && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{body}</p>}
      {isLog && (
        <>
          <p className="mt-3 text-xs text-[#7b806d]">Agent-reported note</p>
          {typeof data.nextStep === "string" && (
            <p className="mt-2 text-sm">
              <strong>Next step: </strong>
              {text(data.nextStep)}
            </p>
          )}
          {Array.isArray(data.evidence) && data.evidence.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-sm">
              {data.evidence.map((item, i) => (
                <li className="break-words" key={i}>
                  {text(item)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {data.truncated === true && (
        <p className="mt-2 text-xs">Output truncated; content hash preserved in details.</p>
      )}
      <details className="mt-3 text-xs text-[#718174]">
        <summary>
          Details · #{event.sequence}
          {event.sessionId ? ` · session ${event.sessionId.slice(0, 8)}` : ""}
        </summary>
        <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-[#f6f7f2] p-3">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </details>
    </article>
  );
}

function App() {
  const demo = new URLSearchParams(location.search).has("demo");
  const [token, setToken] = useState(demo ? "offline-demo-operator-token-32-characters" : "");
  const [draft, setDraft] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [team, setTeam] = useState<Team | null>(null);
  const [agentId, setAgentId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [events, setEvents] = useState<Activity[]>([]);
  const [tab, setTab] = useState("activity");
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState("");
  const [update, setUpdate] = useState(0);
  const [lastReceived, setLastReceived] = useState<string | null>(null);

  async function api<T>(path: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(path, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok)
      throw new Error(`Request failed (${response.status}): ${await response.text()}`);
    return response.json();
  }
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void api<Run[]>("/operator/runs", controller.signal)
      .then((items) => {
        setRuns(items);
        setRunId(items[0]?._id ?? "");
        setError("");
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) {
          setError(error.message);
          setToken("");
        }
      });
    return () => controller.abort();
  }, [token]);
  useEffect(() => {
    setTeam(null);
    setAgentId("");
    setEvents([]);
    setLastReceived(null);
    if (!token || !runId) return;
    const controller = new AbortController();
    const refresh = () => {
      void api<Team>(`/operator/runs/${runId}`, controller.signal)
        .then((data) => {
          setTeam(data);
          setAgentId((selected) =>
            data.agents.some((agent) => agent._id === selected)
              ? selected
              : (data.agents[0]?._id ?? ""),
          );
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted) setError(error.message);
        });
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [token, runId]);
  useEffect(() => {
    if (!token || !runId) return;
    const controller = new AbortController();
    void watchActivity({
      baseUrl: location.origin,
      token,
      runId,
      signal: controller.signal,
      onEvent: (event) => {
        setEvents((prior) =>
          [...prior.filter((item) => item.sequence !== event.sequence), event].slice(-500),
        );
        setLastReceived(new Date().toISOString());
        if (event.type.startsWith("invocation_") || event.type === "agent_stopped") {
          const status = text(object(event.payload).status);
          if (status)
            setTeam((prior) =>
              prior
                ? {
                    ...prior,
                    agents: prior.agents.map((agent) =>
                      agent._id === event.agentId && event.generation >= agent.generation
                        ? { ...agent, status, generation: event.generation }
                        : agent,
                    ),
                  }
                : prior,
            );
          setUpdate((count) => count + 1);
        }
      },
      onConnection: (state, message) => {
        setConnection(state);
        setError(message ?? "");
      },
    }).catch((error: Error) => {
      if (!controller.signal.aborted) {
        setError(error.message);
        setConnection("disconnected");
      }
    });
    return () => controller.abort();
  }, [token, runId]);
  useEffect(() => {
    setDetail(null);
    if (!token || !runId || !agentId) return;
    const controller = new AbortController();
    const refresh = () => {
      void api<Detail>(`/operator/runs/${runId}/agents/${agentId}`, controller.signal)
        .then(setDetail)
        .catch((error: Error) => {
          if (!controller.signal.aborted) setError(error.message);
        });
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [token, runId, agentId, update]);

  const ownEvents = events.filter((event) => event.agentId === agentId);
  const visible = ownEvents.filter((event) =>
    tab === "logs"
      ? event.type === "work_log"
      : tab === "session"
        ? event.type === "message_end" || event.type === "tool_execution_end"
        : event.type !== "message_start" &&
          event.type !== "tool_execution_update" &&
          event.type !== "message_update",
  );
  const latest = ownEvents.at(-1) ?? detail?.lastActivity;
  const selected = team?.agents.find((agent) => agent._id === agentId);
  const liveText = ownEvents.filter((event) => event.type === "message_update").at(-1);
  const showDraft =
    selected?.status === "running" &&
    liveText &&
    !ownEvents.some((event) => event.type === "message_end" && event.sequence > liveText.sequence);

  return (
    <main className="mx-auto max-w-[1500px] p-5 md:p-9">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-5">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#244d38] text-xl text-white">
            a
          </span>
          <div>
            <h1 className="text-lg font-semibold">atoi</h1>
            <p className="text-xs text-[#788375]">Your persistent team</p>
          </div>
        </div>
        {token && (
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-xs text-[#657565]">
              ● {connection}
              {lastReceived ? ` · updated ${new Date(lastReceived).toLocaleTimeString()}` : ""}
            </span>
            <button
              className="text-xs underline"
              onClick={() => {
                setToken("");
                setEvents([]);
                setRuns([]);
                setRunId("");
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </header>
      {demo && (
        <p className="mb-5 rounded-lg border border-[#e2d7b2] bg-[#fff9e8] p-3 text-sm">
          Scripted offline demo · no model calls or Modal sandboxes. Activity is persisted in a
          temporary local MongoDB replica set.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-5 rounded-lg bg-[#fbece8] p-3 text-sm text-[#974b3a]">
          {error}
        </p>
      )}
      {!token ? (
        <form
          className="mx-auto mt-20 max-w-md rounded-2xl border border-[#dfe5d8] bg-white p-8"
          onSubmit={(event) => {
            event.preventDefault();
            setToken(draft);
            setDraft("");
          }}
        >
          <p className="text-xs uppercase tracking-widest text-[#718174]">Team activity</p>
          <h2 className="mt-3 text-2xl font-medium">Connect to your team</h2>
          <p className="mt-3 text-sm leading-6 text-[#718174]">
            See what each agent is doing, inspect its work, and follow the handoffs.
          </p>
          <label className="mt-6 block text-sm">
            Access token
            <input
              type="password"
              required
              autoComplete="off"
              className="mt-2 w-full rounded-lg border border-[#dce3d6] px-3 py-2"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button className="mt-5 w-full rounded-lg bg-[#244d38] py-3 text-sm text-white">
            Connect
          </button>
          <p className="mt-3 text-xs text-[#788375]">Your token stays in this tab’s memory.</p>
        </form>
      ) : (
        <>
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-[#718174]">Team workspace</p>
              <h2 className="mt-2 text-3xl font-medium tracking-tight">
                See the work as it happens.
              </h2>
            </div>
            <label className="text-xs text-[#718174]">
              Run
              <select
                aria-label="Select run"
                className="ml-3 max-w-80 rounded-lg border border-[#dce3d6] bg-white px-3 py-2 text-sm text-[#25382e]"
                value={runId}
                onChange={(event) => setRunId(event.target.value)}
              >
                {runs.map((run) => (
                  <option key={run._id} value={run._id}>
                    {run.objective.slice(0, 65)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!runId ? (
            <p className="rounded-xl border border-[#dfe5d8] bg-white p-8">
              No runs yet. Start a run with the CLI, then reconnect to view its agents.
            </p>
          ) : (
            <>
              <section className="mb-6 rounded-xl border border-[#dfe5d8] bg-[#edf1e6] px-5 py-4">
                <p className="text-xs uppercase tracking-wider text-[#718174]">
                  Objective · {team?.run.status ?? "loading"}
                </p>
                <p className="mt-2 text-sm">{team?.run.objective ?? "Loading team…"}</p>
              </section>
              <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)_260px]">
                <aside>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#788375]">
                    Agents · {team?.agents.length ?? 0}
                  </h3>
                  <nav aria-label="Team agents" className="space-y-2">
                    {team?.agents.map((agent, index) => (
                      <button
                        key={agent._id}
                        aria-pressed={agent._id === agentId}
                        onClick={() => setAgentId(agent._id)}
                        className={`w-full rounded-xl border p-4 text-left ${agent._id === agentId ? "border-[#91b69a] bg-[#e7eee1]" : "border-[#e3e8de] bg-white"}`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#dce5d5] text-xs font-medium">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="text-sm font-medium capitalize">{agent.role}</span>
                        </div>
                        <p className="mt-3 text-xs text-[#657565]">● {label(agent.status)}</p>
                        <p className="mt-2 font-mono text-[10px] text-[#849080]">
                          {agent._id.slice(0, 12)}
                        </p>
                      </button>
                    ))}
                  </nav>
                </aside>
                <section className="min-w-0">
                  <div className="mb-4 flex items-center justify-between gap-4">
                    <h3 className="text-xl font-medium capitalize">{selected?.role ?? "Agent"}</h3>
                    <span className="rounded-full bg-[#e4ebdc] px-3 py-1 text-xs">
                      {selected?.status === "running" && latest
                        ? title(latest)
                        : label(selected?.status ?? "loading")}
                    </span>
                  </div>
                  <div
                    role="tablist"
                    aria-label="Agent views"
                    className="mb-5 flex gap-5 border-b border-[#dfe5d8]"
                  >
                    {[
                      ["activity", "Activity"],
                      ["session", "Session history"],
                      ["logs", "Working log"],
                    ].map(([key, title]) => (
                      <button
                        key={key}
                        role="tab"
                        aria-selected={tab === key}
                        onClick={() => setTab(key!)}
                        className={`pb-3 text-sm ${tab === key ? "border-b-2 border-[#397a56] font-medium" : "text-[#788375]"}`}
                      >
                        {title}
                      </button>
                    ))}
                  </div>
                  {showDraft && tab !== "logs" && (
                    <div className="mb-4 rounded-xl border border-dashed border-[#a0b799] bg-[#eff3ea] p-5">
                      <p className="mb-2 text-xs text-[#718174]">Response in progress</p>
                      <p className="whitespace-pre-wrap text-sm leading-6">{content(liveText)}</p>
                    </div>
                  )}
                  <div role="tabpanel" className="space-y-3">
                    {visible.length ? (
                      [...visible]
                        .reverse()
                        .map((event) => <EventCard key={event._id} event={event} />)
                    ) : (
                      <p className="rounded-xl border border-dashed border-[#d5decc] p-8 text-center text-sm text-[#788375]">
                        {tab === "logs"
                          ? "Working notes will appear when this agent records them."
                          : "Waiting for recorded activity."}
                      </p>
                    )}
                  </div>
                  <p className="mt-5 text-xs text-[#849080]">
                    Showing the latest 500 team events. Older history remains available through the
                    paginated history API and CLI.
                  </p>
                </section>
                <aside className="space-y-5">
                  <section className="rounded-xl border border-[#e3e8de] bg-white p-5">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-[#788375]">
                      Assigned work
                    </h3>
                    {detail?.tasks.length ? (
                      detail.tasks.map((task) => (
                        <div key={task._id} className="mt-4 border-t border-[#edf0e8] pt-4">
                          <p className="text-sm leading-6">{task.description}</p>
                          <p className="mt-2 text-xs text-[#718174]">{label(task.status)}</p>
                          {task.result?.commit && (
                            <p className="mt-2 font-mono text-xs">
                              Commit {task.result?.commit.slice(0, 12)}
                            </p>
                          )}
                          {task.review?.verification ??
                            (task.result?.verification && (
                              <details className="mt-3 text-xs">
                                <summary>Reported evidence</summary>
                                <p className="mt-2 whitespace-pre-wrap">
                                  {task.review?.verification ?? task.result?.verification}
                                </p>
                              </details>
                            ))}
                        </div>
                      ))
                    ) : (
                      <p className="mt-4 text-sm text-[#788375]">No owned tasks.</p>
                    )}
                  </section>
                  <section className="rounded-xl border border-[#e3e8de] bg-white p-5">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-[#788375]">
                      Continuity
                    </h3>
                    <dl className="mt-4 space-y-3 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-[#788375]">Turns</dt>
                        <dd>{selected?.turns ?? 0}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-[#788375]">Generation</dt>
                        <dd>{selected?.generation ?? 0}</dd>
                      </div>
                    </dl>
                    <p className="mt-4 text-xs leading-5 text-[#788375]">
                      History stays with the agent when its sandbox is replaced. Closing this view
                      does not stop the run.
                    </p>
                  </section>
                </aside>
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
