import { useNow, useRunState } from "../app/context";
import { clock, duration, shortClock, tokens, usd } from "../state/format";
import {
  isTerminal,
  roleOf,
  selectCounters,
  selectHandoff,
  selectRecovery,
  selectResult,
  selectUsage,
  workersInUse,
} from "../state/selectors";
import {
  AgentChip,
  CommitChip,
  RichText,
  RUN_STATUS_COLOR,
  SectionTitle,
  StateMarker,
  TaskChip,
} from "../ui/chips";

function Elapsed() {
  const state = useRunState();
  const now = useNow(1000);
  const { elapsedMs } = selectCounters(state, now);
  return <>{elapsedMs === undefined ? "–" : duration(elapsedMs)}</>;
}

export function Check({ passed }: { passed: boolean }) {
  return passed ? (
    <span className="font-semibold text-green" aria-label="passed">
      ✓
    </span>
  ) : (
    <span className="font-semibold text-red" aria-label="failed">
      ✗
    </span>
  );
}

export function Summary() {
  const state = useRunState();
  const run = state.run;
  const handoff = selectHandoff(state);
  const result = selectResult(state);
  const recovery = selectRecovery(state);
  const usage = selectUsage(state);

  return (
    <div className="space-y-1">
      <SectionTitle>objective</SectionTitle>
      <p className="font-sans text-title leading-snug">
        {run?.objective ?? <span className="text-muted">Not reported yet.</span>}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-body">
        {run?.repo && (
          <>
            <dt className="text-muted">repo</dt>
            <dd>{run.repo}</dd>
          </>
        )}
        {run && (
          <>
            <dt className="text-muted">status</dt>
            <dd>
              <StateMarker color={RUN_STATUS_COLOR[run.status]} label={run.status} />
            </dd>
          </>
        )}
        <dt className="text-muted">elapsed</dt>
        <dd>
          <Elapsed />
        </dd>
        {run?.workerLimit !== undefined && (
          <>
            <dt className="text-muted">workers</dt>
            <dd>
              {workersInUse(state)} of {run.workerLimit} in use
            </dd>
          </>
        )}
      </dl>

      <SectionTitle>handoff</SectionTitle>
      {handoff.length === 0 && <p className="text-body text-muted">No tasks yet.</p>}
      {handoff.map(({ task, entries }) => (
        <div key={task.id} className="mb-3">
          <div className="mb-1 flex items-baseline gap-2 text-body">
            <TaskChip id={task.id} />
            <span className="truncate font-sans" title={task.title}>
              {task.title}
            </span>
          </div>
          <ol className="ml-2 border-l-2 border-line/60 pl-3 text-body">
            {entries.map((e) => (
              <li key={`${e.kind}-${e.seq}`} className="relative py-0.5">
                <span
                  aria-hidden
                  className="absolute -left-[17px] top-[9px] size-2 rounded-full border-2 border-paper"
                  style={{
                    background:
                      e.kind === "verify"
                        ? e.passed
                          ? "var(--color-green)"
                          : "var(--color-red)"
                        : e.kind === "push"
                          ? "var(--color-accent)"
                          : "var(--color-ink)",
                  }}
                />
                <span className="mr-2 text-muted">{shortClock(e.ts)}</span>
                {e.kind === "verify" && (
                  <>
                    <Check passed={!!e.passed} />{" "}
                  </>
                )}
                <RichText text={e.text} />
              </li>
            ))}
          </ol>
        </div>
      ))}

      <SectionTitle>result</SectionTitle>
      {result.finalCommit ? (
        <div className="space-y-1 text-body">
          <div>
            final commit <CommitChip commit={result.finalCommit} />
          </div>
          {result.outcome && (
            <p className="font-sans">
              <RichText text={result.outcome} />
            </p>
          )}
          {result.latestVerification && (
            <div>
              <Check passed={result.latestVerification.passed} />{" "}
              {result.latestVerification.command}
              {result.latestVerification.summary ? ` (${result.latestVerification.summary})` : ""}
              {result.latestVerification.agentId && (
                <span className="text-muted">
                  , by {roleOf(state, result.latestVerification.agentId)}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="text-body text-muted">
          {isTerminal(state) ? "The run ended without a final commit." : "No result yet."}
        </p>
      )}

      <SectionTitle>recovery and failures</SectionTitle>
      {recovery.restarts.length + recovery.replacements.length + recovery.failures.length === 0 ? (
        <p className="text-body text-muted">None recorded.</p>
      ) : (
        <ul className="space-y-1 text-body">
          {recovery.restarts.map((r) => (
            <li key={`r${r.seq}`}>
              <span className="mr-2 text-muted">{clock(r.ts)}</span>
              <span className="text-amber">Temporal worker restarted</span>
            </li>
          ))}
          {recovery.replacements.map((r) => (
            <li key={`s${r.seq}`}>
              <span className="mr-2 text-muted">{clock(r.ts)}</span>
              <AgentChip id={r.agentId} /> sandbox {r.oldId} → {r.newId}
              {state.agents[r.agentId] && (
                <span className="text-muted">, now gen {state.agents[r.agentId]!.generation}</span>
              )}
            </li>
          ))}
          {recovery.failures.map((f) => (
            <li key={f.id} className={f.resolved ? "text-muted" : "text-red"}>
              <span className="mr-2 text-muted">{clock(f.ts)}</span>[{f.scope}] {f.message}
              {f.agentId && (
                <>
                  {" "}
                  <AgentChip id={f.agentId} />
                </>
              )}
              {f.resolved && (
                <span className="ml-1 rounded-box border border-line px-1 text-chip">resolved</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>usage</SectionTitle>
      <table className="w-full text-body">
        <thead>
          <tr className="text-left text-muted">
            <th className="font-normal">agent</th>
            <th className="text-right font-normal">tokens</th>
            <th className="text-right font-normal">cost</th>
            <th className="text-right font-normal">active</th>
          </tr>
        </thead>
        <tbody>
          {usage.rows.map((r) => (
            <tr key={r.agentId}>
              <td className="py-0.5">
                <AgentChip id={r.agentId} />
              </td>
              <td className="text-right">{tokens(r.tokens)}</td>
              <td className="text-right">{usd(r.costUsd)}</td>
              <td className="text-right">{duration(r.activeMs)}</td>
            </tr>
          ))}
          <tr className="border-t border-line/60 font-medium">
            <td className="pt-1">total</td>
            <td className="pt-1 text-right">{tokens(usage.total.tokens)}</td>
            <td className="pt-1 text-right">{usd(usage.total.costUsd)}</td>
            <td className="pt-1 text-right">{duration(usage.total.activeMs)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
