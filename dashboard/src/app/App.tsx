import { useEffect, useState } from "react";
import { type Resolved, resolveSource } from "../sources/resolve";
import { RunView } from "./RunView";

function Message({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-[64px] items-center border-b-2 border-ink bg-card px-4">
        <span className="text-lead font-semibold">atoi</span>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-xl border-2 border-ink bg-card p-6">
          <p className="text-lead">{title}</p>
          {children && <div className="mt-3 text-body text-muted">{children}</div>}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [resolved, setResolved] = useState<Resolved | { kind: "loading" }>({ kind: "loading" });

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      const r = await resolveSource(location.search, abort.signal).catch((err: unknown) => ({
        kind: "error" as const,
        message: String(err),
      }));
      if (abort.signal.aborted) return;
      setResolved(r);
      // No runs yet: poll /api/runs every 5 s until one appears.
      if (r.kind === "no-runs") timer = setTimeout(attempt, 5000);
    };
    void attempt();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, []);

  switch (resolved.kind) {
    case "loading":
      return <Message title="Connecting…" />;
    case "no-runs":
      return <Message title="No runs yet. Start one from the CLI and it will appear here." />;
    case "error":
      return (
        <Message title="Couldn't reach the backend.">
          <p>{resolved.message}</p>
          <p className="mt-2">
            To look at scripted data instead, open{" "}
            <a className="text-accent underline" href="?source=mock">
              ?source=mock
            </a>
            .
          </p>
        </Message>
      );
    case "ready":
      return <RunView source={resolved.source} runs={resolved.runs} />;
  }
}
