import { useEffect, useState } from "react";
import { useNow, useRun, useRunSnapshot, useRunState } from "../app/context";
import { urlFor } from "../sources/resolve";
import { unknownCount } from "../state/chat";
import { duration, tokens, usd } from "../state/format";
import { selectCounters } from "../state/selectors";
import { useStore } from "../state/store";
import { RUN_STATUS_COLOR, StateMarker } from "../ui/chips";

function Counter({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="text-lead font-medium">{value}</span>
      <span className="atoi-label text-chip text-muted">{label}</span>
    </div>
  );
}

function SourceLabel() {
  const { source } = useRun();
  if (source.kind === "live" && !source.mock) {
    return (
      <span className="flex items-center gap-1.5 text-body text-accent">
        <span aria-hidden className="atoi-live-dot inline-block size-2.5 rounded-full bg-accent" />{" "}
        live
      </span>
    );
  }
  return <span className="text-body text-amber">mock</span>;
}

/** Never fail silently: say how many events couldn't be shown. */
function DroppedEvents() {
  const skipped = useRunSnapshot((s) => s.skipped);
  const unknown = useRunSnapshot((s) => unknownCount(s.events));
  if (!skipped && !unknown) return null;
  const parts = [
    skipped ? `${skipped} malformed event${skipped === 1 ? "" : "s"} skipped` : "",
    unknown ? `${unknown} event${unknown === 1 ? "" : "s"} of an unknown type` : "",
  ].filter(Boolean);
  return (
    <span
      className="max-w-[160px] text-chip leading-tight text-red"
      title={`${parts.join("; ")}. Details are in the browser console.`}
    >
      {parts.join(", ")}
    </span>
  );
}

function RunPicker() {
  const { runs, source } = useRun();
  if (runs.length < 2) return null;
  const kind = source.kind === "live" ? "live" : "mock";
  const current =
    source.kind === "live"
      ? source.runId
      : (new URLSearchParams(location.search).get("fixture") ?? "happy-path");
  return (
    <label className="flex items-center gap-1.5 text-chip text-muted">
      {kind === "mock" ? "fixture" : "run"}
      <select
        value={current}
        onChange={(e) => {
          // Keep the theme when switching runs or fixtures.
          const theme = new URLSearchParams(location.search).get("theme");
          location.search =
            urlFor(kind, e.target.value) + (theme ? `&theme=${encodeURIComponent(theme)}` : "");
        }}
        className="rounded-box border border-line bg-card px-1 py-0.5 text-body text-ink"
      >
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.id}
            {r.status ? ` · ${r.status}` : ""}
            {r.mock && kind === "live" ? " · mock" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TopBar() {
  const state = useRunState();
  const now = useNow(1000);
  const c = selectCounters(state, now);
  const run = state.run;
  return (
    <header className="flex min-h-[64px] items-center gap-5 border-b-2 border-ink bg-card px-4 py-2">
      <span className="text-lead font-semibold tracking-tight">atoi</span>
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className="atoi-headline min-w-0 truncate font-sans text-lead" title={run?.objective}>
          {run?.objective ?? <span className="text-muted">Waiting for the run to start…</span>}
        </span>
        {run && (
          <StateMarker
            color={RUN_STATUS_COLOR[run.status]}
            label={run.status}
            className="shrink-0 text-body"
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-5">
        <Counter value={`${c.awake}/${c.agents}`} label="agents awake" />
        <Counter value={String(c.messages)} label="messages" />
        <Counter value={`${c.tasksDone}/${c.tasks}`} label="tasks done" />
        <Counter value={tokens(c.tokens)} label="tokens" />
        <Counter value={usd(c.costUsd)} label="cost" />
        <Counter value={c.elapsedMs === undefined ? "–" : duration(c.elapsedMs)} label="elapsed" />
        <DroppedEvents />
        <SourceLabel />
        <RunPicker />
      </div>
    </header>
  );
}

export function MockStrip() {
  const { source } = useRun();
  if (!(source.kind === "mock" || source.mock)) return null;
  return (
    <div
      role="note"
      className="border-b border-amber bg-amber-tint px-4 py-1 text-body font-medium text-ink"
    >
      {source.kind === "mock"
        ? "Mock data. This is a scripted fixture, not a live run."
        : "Mock data from a local test stream."}
    </div>
  );
}

export function ConnectionStrip() {
  const { status, source } = useRun();
  const { status: s, since } = useStore(status, (v) => v);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!s.retryInMs) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [s.retryInMs, since]);

  if (s.state === "error" && source.kind !== "live") {
    return (
      <div role="alert" className="border-b border-red bg-red-tint px-4 py-1.5 text-body text-ink">
        {s.message}
      </div>
    );
  }
  if (source.kind !== "live") return null;
  if (s.state === "error" && s.notFound) {
    return (
      <div role="alert" className="border-b border-red bg-red-tint px-4 py-1.5 text-body text-ink">
        {s.message}
      </div>
    );
  }
  if (s.state === "error" || s.state === "reconnecting") {
    const left = s.retryInMs
      ? Math.max(0, Math.ceil((since + s.retryInMs - Date.now()) / 1000))
      : undefined;
    return (
      <div
        role="alert"
        className="flex items-center gap-3 border-b border-amber bg-amber-tint px-4 py-1.5 text-body text-ink"
      >
        <span>
          {s.state === "reconnecting"
            ? "Lost connection to the backend. Reconnecting…"
            : `Lost connection to the backend. Retrying in ${left}s.`}
        </span>
        <button
          type="button"
          onClick={() => source.retry?.()}
          className="rounded-box border border-ink px-2 leading-[24px] hover:bg-card"
        >
          Retry now
        </button>
      </div>
    );
  }
  return null;
}
