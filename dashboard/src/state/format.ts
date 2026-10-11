import type { AgentState, TaskStatus } from "../contract/events";

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const shortTimeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function clock(ts: string | number | undefined): string {
  if (ts === undefined) return "--:--:--";
  return timeFmt.format(new Date(ts));
}

export function shortClock(ts: string | number | undefined): string {
  if (ts === undefined) return "--:--";
  return shortTimeFmt.format(new Date(ts));
}

export function sha(commit: string): string {
  return commit.slice(0, 7);
}

/** 3:12, 1:04:09 */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 4m, 2h, 35s */
export function roughDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  provisioning: "provisioning",
  waiting: "waiting",
  running: "running",
  checkpointing: "saving checkpoint",
  recovering: "recovering",
  needs_inspection: "needs inspection",
  failed: "failed",
  stopped: "stopped",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "open",
  in_progress: "in progress",
  blocked: "blocked",
  in_review: "in review",
  done: "done",
};

export function firstLine(body: string, max = 100): string {
  const line = body.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
