import { useState } from "react";
import { api, operatorToken } from "../sources/live";

export function Launch({ error: initialError }: { error?: string }) {
  const [token, setToken] = useState(operatorToken);
  const [repository, setRepository] = useState("");
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [repositories, setRepositories] = useState<Array<{ name: string; url: string }>>();
  const [workers, setWorkers] = useState(2);
  const [minutes, setMinutes] = useState(30);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ fingerprint: string; id: string }>();
  const inputClass =
    "mt-1 w-full rounded-box border border-line bg-paper px-3 py-2 text-body text-ink";
  return (
    <main className="min-h-full bg-paper p-6 text-ink">
      <header className="mx-auto mb-10 flex max-w-3xl items-center justify-between">
        <a href="?source=live" className="text-lead font-semibold">
          atoi
        </a>
        <a href="?source=mock" className="text-body underline">
          Explore demo
        </a>
      </header>
      <form
        className="mx-auto max-w-3xl space-y-5 rounded-box border-2 border-ink bg-card p-8"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          sessionStorage.setItem("atoi.operatorToken", token.trim());
          const payload = {
            repositoryUrl: repository,
            objective: criteria.trim()
              ? `${objective}\n\nAcceptance criteria:\n${criteria}`
              : objective,
            workerLimit: workers,
            lifetimeSeconds: minutes * 60,
          };
          const fingerprint = JSON.stringify(payload);
          const requestId = attempt?.fingerprint === fingerprint ? attempt.id : crypto.randomUUID();
          setAttempt({ fingerprint, id: requestId });
          try {
            const result = await api<{ run: { _id: string } }>("/runs", {
              method: "POST",
              body: JSON.stringify({ ...payload, requestId }),
            });
            location.search = `?source=live&run=${result.run._id}`;
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <h1 className="text-2xl font-semibold">Start your team</h1>
          <p className="mt-2 text-body text-muted">
            Give the orchestrator a bounded objective. It will assign workers, coordinate review,
            and keep the conversation here.
          </p>
        </div>
        <label className="block text-body">
          Operator token
          <input
            type="password"
            autoComplete="off"
            required
            minLength={32}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className={inputClass}
          />
        </label>
        <p className="text-chip text-muted">
          Stored only for this browser tab. Use the operator token from your backend configuration.
        </p>
        <button
          type="button"
          className="text-body underline"
          onClick={async () => {
            sessionStorage.setItem("atoi.operatorToken", token.trim());
            try {
              await api("/runs");
              location.search = "?source=live";
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Connect to existing runs
        </button>
        <label className="block text-body">
          Repository URL
          <input
            type="url"
            required
            list="configured-repositories"
            placeholder="https://github.com/you/project.git"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            className={inputClass}
          />
        </label>
        <datalist id="configured-repositories">
          {repositories?.map((repo) => (
            <option key={repo.name} value={repo.url}>
              {repo.name}
            </option>
          ))}
        </datalist>
        <button
          type="button"
          className="text-body underline"
          onClick={async () => {
            sessionStorage.setItem("atoi.operatorToken", token.trim());
            try {
              const result = await api<{ repositories: Array<{ name: string; url: string }> }>(
                "/repositories",
              );
              setRepositories(result.repositories);
              setError(undefined);
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Show configured repositories
        </button>
        {repositories && (
          <p className="text-chip text-muted">
            {repositories.length
              ? `Configured: ${repositories.map((repo) => repo.name).join(", ")}`
              : "No repositories configured. Add repository access in the backend configuration."}
          </p>
        )}
        <p className="text-chip text-muted">
          Existing and empty repositories are supported. Each repository needs Git access configured
          on the backend.
        </p>
        <label className="block text-body">
          Objective
          <textarea
            required
            rows={4}
            maxLength={16000}
            placeholder="Build a small app or improve an existing project, then independently review the pushed commit."
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block text-body">
          Acceptance criteria
          <textarea
            rows={4}
            maxLength={8000}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
            className={inputClass}
            placeholder="Describe the expected behavior, tests, and deliverables."
          />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="text-body">
            Maximum workers
            <input
              type="number"
              min={1}
              max={8}
              required
              value={workers}
              onChange={(event) => setWorkers(Number(event.target.value))}
              className={inputClass}
            />
          </label>
          <label className="text-body">
            Team lifetime (minutes)
            <input
              type="number"
              min={1}
              max={1380}
              required
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
              className={inputClass}
            />
          </label>
        </div>
        <p className="text-chip text-muted">
          The orchestrator has its own sandbox in addition to these workers. Runs continue when you
          close this tab. Completing an objective leaves the team available for follow-ups. Idle
          sandboxes remain billed until you stop the team or its time limit expires.
        </p>
        {error && (
          <p role="alert" className="text-body text-red">
            {error}
          </p>
        )}
        <button
          disabled={busy}
          className="rounded-box border-2 border-ink bg-ink px-5 py-2 text-card disabled:opacity-50"
          type="submit"
        >
          {busy ? "Starting…" : "Launch team"}
        </button>
      </form>
    </main>
  );
}
