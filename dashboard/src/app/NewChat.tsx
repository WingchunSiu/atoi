import { useEffect, useRef, useState } from "react";
import { fetchRuns, type RunSummary, requestApi } from "../sources/live";

export function NewChat() {
  const [objective, setObjective] = useState("");
  const [repository, setRepository] = useState("");
  const [workers, setWorkers] = useState(2);
  const [minutes, setMinutes] = useState(15);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const request = useRef({ body: "", id: "" });
  useEffect(() => {
    const abort = new AbortController();
    void fetchRuns(abort.signal)
      .then(setRuns)
      .catch((error) => {
        if (!abort.signal.aborted) setError(String(error));
      });
    return () => abort.abort();
  }, []);
  async function send(event: React.FormEvent) {
    event.preventDefault();
    setSending(true);
    setError("");
    const body = JSON.stringify({
      objective: objective.trim(),
      repositoryUrl: repository.trim() || undefined,
      workerLimit: workers,
      lifetimeSeconds: minutes * 60,
      maxInvocationsPerAgent: 20,
    });
    if (request.current.body !== body) request.current = { body, id: crypto.randomUUID() };
    try {
      const response = await requestApi("/runs", {
        method: "POST",
        body: JSON.stringify({ ...JSON.parse(body), requestId: request.current.id }),
      });
      location.search = `?source=live&run=${encodeURIComponent(response.run._id)}`;
    } catch (error) {
      setError(String(error));
      setSending(false);
    }
  }
  return (
    <div className="min-h-full overflow-y-auto bg-paper text-ink">
      <header className="flex items-center justify-between border-b border-line bg-card px-8 py-5">
        <strong className="text-lead">atoi</strong>
        <span className="text-body text-accent">live · your agent team</span>
      </header>
      <main className="mx-auto grid max-w-5xl gap-10 p-8 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <h1 className="mb-3 text-3xl font-semibold">What can we help with?</h1>
          <p className="mb-6 text-body text-muted">
            Start with a message. Your agent can answer directly or bring in peers when the work
            needs them.
          </p>
          <form onSubmit={send} className="space-y-5">
            <label className="block text-body">
              <textarea
                aria-label="Message"
                placeholder="Ask a question or tell us what you want to get done…"
                required
                disabled={sending}
                maxLength={16000}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                rows={4}
                className="mt-2 block w-full rounded-box border border-line bg-card p-3 text-ink"
              />
            </label>
            <details className="rounded-box border border-line p-3">
              <summary className="cursor-pointer text-chip text-muted">
                Conversation settings
              </summary>
              <div className="mt-3 space-y-4">
                <label className="block text-body">
                  Git repository <span className="text-muted">optional</span>
                  <input
                    aria-label="Git repository"
                    value={repository}
                    onChange={(e) => setRepository(e.target.value)}
                    type="url"
                    placeholder="https://github.com/team/repo.git"
                    className="mt-2 block w-full rounded-box border border-line bg-card p-3 text-ink"
                  />
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <label className="text-body">
                    Worker limit
                    <input
                      aria-label="Worker limit"
                      type="number"
                      min={0}
                      max={8}
                      required
                      value={workers}
                      onChange={(e) => setWorkers(Number(e.target.value))}
                      className="mt-2 block w-full rounded-box border border-line bg-card p-3"
                    />
                    <span className="text-chip text-muted">
                      Excludes orchestrator. Zero allows your agent to work independently.
                    </span>
                  </label>
                  <label className="text-body">
                    Time limit · minutes
                    <input
                      aria-label="Time limit"
                      type="number"
                      min={1}
                      max={1380}
                      required
                      value={minutes}
                      onChange={(e) => setMinutes(Number(e.target.value))}
                      className="mt-2 block w-full rounded-box border border-line bg-card p-3"
                    />
                  </label>
                </div>
              </div>
            </details>
            {error && (
              <p role="alert" className="text-body text-red">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={sending || !objective.trim()}
              className="atoi-btn-primary w-full rounded-box border border-ink bg-ink px-4 py-3 text-card disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send message"}
            </button>
            <p className="text-chip text-muted">
              Work continues if you close this page. Use Stop to end the conversation’s compute.
            </p>
          </form>
        </section>
        <aside>
          <h2 className="mb-4 text-lead font-semibold">Conversations</h2>
          {!runs.length && (
            <p className="text-body text-muted">Your conversations will appear here.</p>
          )}
          <ul className="space-y-3">
            {runs.map((run) => (
              <li key={run.id}>
                <a
                  href={`?source=live&run=${encodeURIComponent(run.id)}`}
                  className="block rounded-box border border-line bg-card p-4 hover:border-ink"
                >
                  <span className="block text-chip text-accent">
                    {run.status} · {run.id.slice(0, 10)}
                  </span>
                  <span className="mt-2 line-clamp-3 text-body">{run.objective}</span>
                </a>
              </li>
            ))}
          </ul>
          <a className="mt-6 inline-block text-chip text-muted underline" href="?source=mock">
            Open scripted fixtures
          </a>
        </aside>
      </main>
    </div>
  );
}
