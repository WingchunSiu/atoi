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
messages. See the [product story and inference-scaling thesis](docs/product-story.md).

Code is the first proving ground for this broader product vision. The target
runtime uses Pi for the model/tool loop, one Modal sandbox per agent, Temporal for
scheduling, Atlas for coordination and checkpoints, and Git for project artifacts.
The first full milestone targets an orchestrator plus two workers and a smoke
check adding a third worker. Team continuity is scoped to a run; reusing the same
team across completed runs remains future work.

## Implemented

The initial TypeScript coordination service provides:

- Scoped bearer authentication and operator bootstrap APIs.
- Agent registration with atomic worker-capacity limits.
- Task creation, atomic claims, dependencies and versioned review transitions.
- Team channels and private DMs with ordered, paginated history.
- Atomic message, delivery and outbox writes with request deduplication.
- A read-only pending inbox and structured audit records.

Temporal consumption, checkpoint publication, Pi execution, Modal provisioning
and Git verification are not implemented yet. Outbox entries remain pending until
the Temporal slice is connected. Registration creates logical records only, not
sandboxes. The service does not execute or verify the test results agents report.

## Run locally

Requires Node.js 24+ and pnpm 11.19.0. Use MongoDB Atlas or a replica set; a
standalone MongoDB server cannot execute the required transactions.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `MONGODB_URI`, `MONGODB_DATABASE` and a random `ADMIN_TOKEN` in `.env`. Generate a
token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Never commit `.env` or share the operator token with agents. For Atlas, configure
network access and a database user permitted to read/write the chosen database
and create its indexes.

For a disposable local database instead of Atlas, start this in a separate terminal:

```sh
pnpm db:local
```

It downloads MongoDB 8.2.3 on first use and caches the binary under `.cache/mongodb`.
It binds only to localhost on port 27017 and discards its data when stopped. The
example `.env` URI already targets it. Use Atlas for data that must outlive this
local database process.

Start the coordination service:

```sh
pnpm dev
```

The default address is `http://127.0.0.1:3000`. Change `HOST` and `PORT` as needed;
use TLS when exposing the API remotely. The liveness endpoint is `/health`.

## Coordination demo

With the API running:

```sh
pnpm demo
```

The script creates a uniquely named run and two logical agents, claims a task,
sends a DM, reads the recipient inbox, and submits/approves a synthetic result.
It prints record IDs, never credentials. This is an API demo with fixture evidence;
no model, Git command or sandbox runs. Its inbox stays pending because there is no
checkpointing executor yet. Each invocation creates a fresh run and leaves its
records for inspection. Use a dedicated demo database; there is no shared-data
reset command.

## Checks

```sh
pnpm check
pnpm test:unit
pnpm test:integration
pnpm build
```

`pnpm test` runs both suites. Unit checks need no database or network. Integration
tests start a real temporary MongoDB replica set, requiring a binary download on
first use and local process/socket access. Subsequent runs can reuse the cached
binary offline. Tests create and remove only their randomly named `atoi_test_*`
database, then stop their temporary server.

To test against an existing replica set or Atlas, set `TEST_MONGODB_URI` in the
shell; the test command does not load `.env`. It still creates and deletes only a
unique test database and never uses `MONGODB_DATABASE`. The test identity needs
index-creation, transaction, `collMod` and database-drop permissions in that test
database. The rollback test uses a temporary collection validator to force a real
transaction failure. Local replica-set tests do not establish Atlas cloud access.

Build output goes to `dist/`. Run the compiled service with `pnpm start`.

## Design and contributing

- [Shared state and messaging contract](docs/state-and-messaging.md)
- [Milestone and acceptance checks](docs/milestone-1.md)
- [Agent engineering and PR rules](AGENTS.md)
