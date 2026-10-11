# atoi

**Your persistent AI team in the cloud.**

atoi is building a personal team of agents that stays available as your work
develops. Each agent has its own cloud workspace and session context. Members
share tasks, conversations and evidence, and can consult the same peers again
when a new question builds on earlier work. Completing a task leaves its agent
available for the next conversation.

The technical idea is to organize inference compute across several retained,
focused contexts. Agents investigate different parts of a problem, do real work
in their own sandboxes, and exchange the information they need through direct
messages. Persistence lets those conversations continue after the first answer.
Files retain detailed notes, code and reproducible experiments outside the model
window; peers can inspect versioned artifacts behind a message and ask follow-ups.
See the [product story and inference-scaling thesis](docs/product-story.md).

Code is the first proving ground for this broader product vision. Pi runs the
model/tool loop; Modal provides one sandbox per agent; Temporal schedules work;
Atlas holds durable coordination state and checkpoints; Git holds project files
and artifacts. The first full milestone targets an orchestrator plus two workers
and a smoke check adding a third worker. Team continuity is scoped to a run;
reusing the same team across completed runs remains future work.

## Implemented

The unified TypeScript harness provides:

- Scoped bearer authentication and operator bootstrap APIs.
- One Pi orchestrator that dynamically creates peers with atomic worker-capacity limits.
- Task creation, atomic claims and owner completion, with optional dependencies and peer review.
- Team channels and private DMs with ordered, paginated history.
- Atomic message, delivery and outbox writes with request deduplication.
- A read-only pending inbox and structured audit records.

- Pi coding tools in private Modal workspaces, with bounded model/tool turns.
- Temporal scheduling, durable self-wakeups, outbox reconciliation, per-agent serialization and cleanup.
- Native Pi session checkpoints published atomically with inbox acknowledgement.
- Invocation fencing, confirmed-result reuse and explicit inspection of ambiguous failures.
- Authenticated activity history and SSE APIs, with CLI replay and observation.

The runtime retains each sandbox between turns; idle guests remain alive and billed.
VM pause/resume and automated sandbox replacement are not implemented. The API's
bootstrap registration still creates logical agents only; `/operator/runs` starts
one runtime-enabled orchestrator, which chooses worker roles and instructions through
`spawn_agent`. Workers can finish their own tasks and remain available for follow-up.
Requested peer reviews require a different reviewer; code reviews reference the exact
commit. Evidence remains agent-reported rather than trusted evaluator output.
Research and personal-assistant runs need no repository, Git commit or mandatory reviewer.
`finish_run` records the overall outcome and waits for the orchestrator's final checkpoint
before cleaning up all compute.

Local tests cover the integrated harness with scripted inference and sandbox fixtures.
Real Atlas + Modal + Pi + live-model E2E passed, including independent review,
peer wakeup, native checkpoint history, private file reuse and confirmed cleanup.
The check uses a read-only public Git commit; private Git push remains unverified. See [runtime setup and
limits](docs/runtime.md).

## Run locally

Requires Node.js 24+ and pnpm 11.19.0. Use MongoDB Atlas or a replica set; a
standalone MongoDB server cannot execute the required transactions.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `MONGODB_URI`, `MONGODB_DATABASE`, `ADMIN_TOKEN`, `AGENT_TOKEN_SECRET`,
`BACKEND_PUBLIC_URL`, `PI_PROVIDER` and `PI_MODEL` in `.env`. Generate separate
operator and agent secrets with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Never commit `.env` or share the operator token with agents. For Atlas, configure
network access and a database user permitted to read/write the chosen database
and create its indexes.

For a disposable local database instead of Atlas, start this in a separate terminal:

```sh
pnpm db:local
```

It downloads MongoDB 8.2.3 on first use and caches the binary under `.cache/mongodb`.
It binds only to localhost on port 27017 and discards its data when stopped. The
local connection URI is `mongodb://127.0.0.1:27017/?replicaSet=testset`. Use Atlas for data that must outlive this
local database process.

Start a durable local Temporal service, then the API and worker in separate terminals:

```sh
mkdir -p .atoi
temporal server start-dev --db-filename .atoi/temporal.db
pnpm dev:api
pnpm dev:worker
```

The default address is `http://127.0.0.1:3000`. Change `API_HOST` and `API_PORT` as
needed. Modal workers require an HTTPS `BACKEND_PUBLIC_URL` reaching this API;
configure Modal authentication and a model secret before launching real agents.
The liveness endpoint is `/health`. See [runtime setup](docs/runtime.md) for the
complete setup, CLI run/message/stop sequence and real E2E command.

## Start an orchestrated run

```sh
pnpm cli start https://github.com/<team>/<repo>.git "Implement and independently review a bounded fix" 2
pnpm cli start - "Research this question and return a sourced comparison" 2
pnpm cli start - "Help me plan my week" 0
```

The final argument is the worker limit, excluding the orchestrator (default 2,
range 0–8). Use `-` when no Git repository is needed. Roles are chosen at runtime;
there is no fixed implementer/reviewer pair. `finish_task` ends an individual task,
while the agent remains available within the run. `finish_run` ends the run and stops
all sandboxes; reuse across completed runs is still deferred. See [orchestration
contracts and migration](docs/orchestration.md).

## Coordination demo

With the API running:

```sh
pnpm demo
```

The script creates a uniquely named run and two logical agents, claims a task,
sends a DM, reads the recipient inbox, and submits/approves a synthetic result.
It prints record IDs, never credentials. This is an API demo with fixture evidence;
no model, Git command or sandbox runs. Its logical agents are not runtime-enabled,
so their inbox remains pending. Each invocation creates a fresh run and leaves its
records for inspection. Use a dedicated demo database; there is no shared-data
reset command.

## Agent activity APIs and CLI

Pi session messages, visible text, tool output and agent working logs are recorded
as ordered Atlas events. The CLI can inspect an agent, replay history and watch
live activity. Working notes are agent reports and do not approve tasks.

```sh
pnpm cli agent <runId> <agentId>
pnpm cli history <runId> [agentId] [afterCursor]
pnpm cli watch <runId> [agentId] [afterCursor]
```

The browser UI is developed separately against the authenticated backend APIs.
This runtime includes the activity contract and CLI, with paginated replay and
reconnecting observation. See [activity APIs and limits](docs/activity.md) and
[runtime setup](docs/runtime.md).

## Checks

```sh
pnpm check
pnpm test:unit
pnpm test:integration
pnpm test:runtime
pnpm build
```

`pnpm test` runs the coordination and runtime/activity suites. Unit checks need no
database or network. Coordination integration
tests start a real temporary MongoDB replica set, requiring a binary download on
first use and local process/socket access. Subsequent runs can reuse the cached
binary offline. Tests create and remove only their randomly named `atoi_test_*`
database, then stop their temporary server.

To test against an existing replica set or Atlas, set `TEST_MONGODB_URI` in the
shell; the test command does not load `.env`. It still creates and deletes only a
unique test database and never uses `MONGODB_DATABASE`. The test identity needs
index-creation, transaction, `collMod` and database-drop permissions in that test
database. The rollback test uses a temporary collection validator to force a real
transaction failure. Local replica-set tests do not establish Atlas cloud access. Runtime tests also
start real local Temporal services and use scripted inference/sandbox fixtures;
first use may download the Temporal executable.

Build output goes to `dist/`. Run the compiled service with `pnpm start`.

## Dashboard

The [dashboard](dashboard/README.md) starts with a chat message: sending the first
message durably creates a run and wakes its orchestrator. Optional conversation
settings control the repository, worker cap and deadline. Continue in the same chat,
message peers, inspect recorded activity and stop compute from the browser.

For a local live demo with real Atlas, Modal, Pi and a persistent local Temporal service:

```sh
pnpm build
CLOUDFLARED_PATH=/path/to/cloudflared pnpm demo:web
```

Open `http://127.0.0.1:5173/`, send a short planning request, then ask a follow-up.
The runner reads `.env`, creates private local operator credentials, and uses
`browser_*` collections within the configured Atlas database. It never resets them.
Closing the browser leaves work running; Stop, the deadline, or Ctrl-C ends compute.
Idle sandboxes remain billed. The Vite operator gateway binds to loopback and injects
its server-side token; it is a local demo, not a hosted browser authentication solution.
With separately running API/worker services, set `ADMIN_TOKEN` and `VITE_API_TARGET`
and run `pnpm --filter atoi-dashboard dev`. Offline fixtures remain at `?source=mock`.

## Design and contributing

- [Shared state and messaging contract](docs/state-and-messaging.md)
- [Milestone and acceptance checks](docs/milestone-1.md)
- [Agent engineering and PR rules](AGENTS.md)
