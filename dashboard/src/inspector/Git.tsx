import { useEffect, useRef } from "react";
import { useRunState, useUi } from "../app/context";
import { clock } from "../state/format";
import type { Commit } from "../state/reduce";
import { AgentChip, CommitChip } from "../ui/chips";
import { Check } from "./Summary";

function CommitRow({ commit, selected }: { commit: Commit; selected: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <li
      ref={ref}
      className={`rounded-box border px-2 py-2 ${selected ? "border-ink bg-hub" : "border-line/50"}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-body">
        <CommitChip commit={commit.sha} />
        {commit.branch && <span>{commit.branch}</span>}
        {commit.agentId && <AgentChip id={commit.agentId} />}
        <span className="ml-auto text-chip text-muted">
          {commit.ts ? clock(commit.ts) : "push not seen"}
        </span>
      </div>
      {commit.message && <p className="mt-1 font-sans text-body">{commit.message}</p>}
      {commit.verifications.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-body">
          {commit.verifications.map((v) => (
            <li key={v.seq} className="flex flex-wrap items-baseline gap-x-2">
              <Check passed={v.passed} />
              <span>{v.command}</span>
              {v.summary && <span className="text-muted">{v.summary}</span>}
              {v.agentId && (
                <span className="ml-auto">
                  <AgentChip id={v.agentId} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Git() {
  const state = useRunState();
  const selected = useUi((u) => u.selectedCommit);
  const commits = Object.values(state.commits).sort((a, b) => b.seq - a.seq);
  if (!commits.length) return <p className="text-body text-muted">No commits reported yet.</p>;
  return (
    <ul className="space-y-2">
      {commits.map((c) => (
        <CommitRow key={c.sha} commit={c} selected={selected === c.sha} />
      ))}
    </ul>
  );
}
