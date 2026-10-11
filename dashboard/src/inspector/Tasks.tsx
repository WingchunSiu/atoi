import { useEffect, useRef } from "react";
import { useRunState, useUi } from "../app/context";
import type { TaskStatus } from "../contract/events";
import { clock, TASK_STATUS_LABEL, truncate } from "../state/format";
import type { TaskView } from "../state/reduce";
import { describeTaskChange } from "../state/selectors";
import { AgentChip, CommitChip, RichText, TaskChip } from "../ui/chips";
import { ui } from "../ui/uiStore";

const GROUP_ORDER: TaskStatus[] = ["in_progress", "in_review", "blocked", "open", "done"];

function TaskRow({ task, open }: { task: TaskView; open: boolean }) {
  const state = useRunState();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const deps = task.dependsOn?.length ?? 0;
  return (
    <li
      ref={ref}
      className={`rounded-box border ${open ? "border-ink bg-card" : "border-transparent"}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => ui.set({ selectedTask: open ? undefined : task.id })}
        className="flex w-full items-baseline gap-2 px-2 py-1.5 text-left hover:bg-hub"
      >
        <span className="shrink-0 font-medium" title={task.id}>
          {truncate(task.id, 13)}
        </span>
        <span className="min-w-0 flex-1 truncate font-sans text-body" title={task.title}>
          {task.title}
        </span>
      </button>
      <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5 text-chip text-muted">
        {task.ownerId ? <AgentChip id={task.ownerId} /> : <span>unowned</span>}
        {task.resultCommit && <CommitChip commit={task.resultCommit} />}
        {deps > 0 && (
          <span>
            {deps} dependenc{deps === 1 ? "y" : "ies"}
          </span>
        )}
      </div>
      {open && (
        <div className="space-y-2 border-t border-line/60 px-2 py-2 text-body [overflow-wrap:anywhere]">
          {task.verification && (
            <p className="whitespace-pre-wrap">
              <span className="text-muted">Implementation evidence (agent-reported): </span>
              {task.verification}
            </p>
          )}
          {task.review && (
            <p className="whitespace-pre-wrap">
              <span className="text-muted">Independent review (agent-reported): </span>
              {task.review}
            </p>
          )}
          {task.description && (
            <p className="font-sans">
              <RichText text={task.description} />
            </p>
          )}
          {task.acceptance && task.acceptance.length > 0 && (
            <div>
              <div className="text-muted">acceptance</div>
              <ul className="ml-4 list-disc font-sans">
                {task.acceptance.map((a) => (
                  <li key={a}>
                    <code className="font-mono text-chip">{a}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {deps > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted">depends on</span>
              {task.dependsOn!.map((d) => (
                <TaskChip key={d} id={d} />
              ))}
            </div>
          )}
          <div>
            <div className="text-muted">history</div>
            <ol>
              {task.history.map((h, i) => (
                <li key={h.seq}>
                  <span className="mr-2 text-muted">{clock(h.ts)}</span>
                  <RichText text={describeTaskChange(state, task.history[i - 1], h)} />
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </li>
  );
}

export function Tasks() {
  const state = useRunState();
  const selected = useUi((u) => u.selectedTask);
  const tasks = Object.values(state.tasks).sort((a, b) => a.createdSeq - b.createdSeq);
  if (tasks.length === 0) return <p className="text-body text-muted">No tasks yet.</p>;
  return (
    <div className="space-y-4">
      {GROUP_ORDER.map((status) => {
        const group = tasks.filter((t) => t.status === status);
        if (!group.length) return null;
        return (
          <section key={status}>
            <h3 className="mb-1 text-title font-semibold">
              {TASK_STATUS_LABEL[status]}{" "}
              <span className="font-normal text-muted">{group.length}</span>
            </h3>
            <ul className="space-y-1">
              {group.map((t) => (
                <TaskRow key={t.id} task={t} open={selected === t.id} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
