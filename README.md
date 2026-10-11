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
See the [product story and inference-scaling thesis](docs/product-story.md).

Code is the first proving ground for this broader product vision. Pi runs the
model/tool loop; Modal provides one sandbox per agent; Temporal schedules work;
Atlas holds durable coordination state and checkpoints; Git holds project files
and artifacts. The first full milestone targets an orchestrator plus two workers
and a smoke check adding a third worker. Team continuity is scoped to a run;
objectives can complete and follow-up tasks can reuse the team until Stop or its
deadline. Reopening a stopped team remains future work.

## Implemented

The unified TypeScript harness provides:

- Scoped bearer authentication and operator bootstrap APIs.
- Agent registration with atomic worker-capacity limits.
- Task creation, atomic claims, dependencies and versioned review transitions.
- Team channels and private DMs with ordered, paginated history.
- Atomic message, delivery and outbox writes with request deduplication.
- A read-only pending inbox and structured audit records.

- Pi coding tools in private Modal workspaces, with bounded model/tool turns.
- Temporal scheduling, durable outbox reconciliation, per-agent serialization and cleanup.
- Native Pi session checkpoints published atomically with inbox acknowledgement.
- Invocation fencing, confirmed-result reuse and explicit inspection of ambiguous failures.
- Authenticated activity history and SSE APIs, with CLI replay and observation.
- A Pi orchestrator with deduplicated spawning, configurable worker limits and reviewed-objective completion.
- Explicit replacement of idle, checkpointed sandboxes at a pushed commit.
- A connected dashboard for launching, messaging, inspecting and stopping teams.

The runtime retains each sandbox between turns; idle guests remain alive and billed.
VM pause/resume and automatic recovery of interrupted work are not implemented. The API's
bootstrap registration still creates logical agents only; `/operator/runs` starts
runtime-enabled agents. Task approval requires an independent reviewer of the exact
commit, but evidence remains agent-reported rather than trusted evaluator output.

Local tests cover the integrated harness with scripted inference and sandbox fixtures.
The real Atlas + Modal + Pi + DeepSeek check also completed an orchestrator-driven
implementation push, independent exact-commit review, Temporal worker restart,
native checkpoint recovery in a replacement sandbox and confirmed cleanup.
See [runtime evidence, setup and limits](docs/runtime.md).

## Run locally

For interactive use, configure `.env` with Atlas, Modal/model access and
`GITHUB_REPOSITORIES` (repository → scoped Modal Git secret), then run:

```sh
pnpm build
pnpm dev:live
# In a second terminal:
VITE_API_TARGET=http://127.0.0.1:3200 pnpm dev:dashboard
```

Open the printed dashboard URL. Enter `ADMIN_TOKEN`, choose a configured repository,
and provide an objective and acceptance criteria. Empty repositories are supported;
no fixture files are required. After the objective completes, message the same
orchestrator for another task. **Stop** or the team lifetime ends the team; idle
sandboxes remain billed. See [interactive setup and repository access](docs/runtime.md#interactive-teams-and-arbitrary-repository-tasks).


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

The browser UI reads authenticated, paginated domain events from the same Atlas
event collection. The CLI also exposes raw Pi text and tool results through SSE. See [activity APIs and limits](docs/activity.md) and
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

With the API and Temporal worker running, start the connected UI:

```sh
pnpm dev:dashboard
```

Open `http://localhost:5173`, enter `ADMIN_TOKEN`, a demo repository URL and a
bounded objective, then launch a team. The operator token stays in this tab's
session storage. Vite proxies authenticated `/api` requests to `/operator` at
port 3000; set `VITE_API_TARGET` to change that address. A deployed dashboard
needs the same proxy over HTTPS. `vite preview` alone is not a production backend.

For a local UI integration demo without cloud credentials, run `pnpm demo:dashboard`
and `pnpm dev:dashboard` in separate terminals. Use the demo token printed by the
first command. This runs the real API and a disposable MongoDB replica set with
**simulated agents**, explicitly labeled in the UI. It proves no cloud or Git
execution. `?source=mock` retains the fully offline fixtures.

Run `pnpm test:dashboard` and `pnpm build:all` to check both packages.
See [dashboard usage](dashboard/README.md) and the
[full writable fixture check](docs/runtime.md#real-e2e-check).

## Design and contributing

- [Shared state and messaging contract](docs/state-and-messaging.md)
- [Milestone and acceptance checks](docs/milestone-1.md)
- [Agent engineering and PR rules](AGENTS.md)
