# Modal agent runtime

The first implementation keeps Pi's model/tool loop inside a private Modal
sandbox. It adds backend coordination tools, native session checkpoints and
Temporal scheduling around that loop. Normal Pi read, write, edit and shell tools
operate on the guest's workspace; the trusted runner does not execute them.

## Implemented behavior

| Component | Current behavior |
| --- | --- |
| Modal adapter | Common Node/Git/Python image, named sandbox per agent, private Git clone, explicit lifetime, reattachment and termination |
| Pi worker | Standard SDK resource discovery and coding tools, appended agent identity/instructions, peer/task tools, bounded turns |
| Persistence | Native Pi JSONL in Atlas with a content hash; checkpoint publication and inbox acknowledgement in one transaction |
| Communication | Team channel and peer DMs; addressed messages/mentions create deliveries and outbox wakeups |
| Tasks | Atomic claims, task versions/dependencies, independent assigned-reviewer approval of the exact commit |
| Temporal | Serialized per-agent turns, idle waits, reconciliation timers, run deadline and independent cleanup workflows |
| Harness API | Operator token, agent-scoped tokens, invocation generation checks, persisted events and status inspection |
| CLI | Start a two-agent fixture, inspect a run, send a follow-up and stop compute |

Finishing a turn or task leaves the same agent and sandbox available. While idle,
Temporal waits without a Pi invocation running. The sandbox stays alive and billed;
this is not VM pause or a memory snapshot. A new delivery starts a fresh worker
process in that sandbox and restores the native session checkpoint from Atlas.
Files, installed dependencies and other guest state remain in the living sandbox.

Each invocation has a stable ID and generation. The guest caches a confirmed
result and rejects overlapping/interrupted work. The harness reads that cache if
a response is lost. Unconfirmed effects become `needs_inspection`, leaving the
delivery unacknowledged; shell commands are not blindly replayed. Completed
invocations commit their checkpoint and delivery acknowledgements together.

## Setup

Use Node 24+, pnpm 11.19.0, the Temporal CLI, a Modal account/profile and access to the
hackathon's Atlas cluster. The production adapter uses `modal@0.11.0` and
`@earendil-works/pi-coding-agent@1.1.0`; dependencies are pinned in `pnpm-lock.yaml`.
The Pi packages are published under the `@earendil-works` namespace.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build
```

Fill the placeholders in `.env`. Create an Atlas database user scoped to the
configured database, allow the trusted backend host to connect, and set
`MONGODB_URI`. All Atlas and Modal provider requests originate from the harness.
Guests and the browser receive no Atlas or Modal credentials.

Configure Modal credentials in the active `~/.modal.toml` profile or through
`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`. Set `ATOI_MODEL_API_KEY` in the trusted backend environment (the adapter injects it as a Modal Secret), or create a named Modal Secret containing
`ATOI_MODEL_API_KEY` and set `MODAL_MODEL_SECRET` to its name. Select a provider/model
pair from the pinned Pi catalog through `PI_PROVIDER` and `PI_MODEL`. Keys stay out
of prompts and command arguments. The guest's model/shell processes share an
environment; this does not isolate credentials from agent-controlled commands.

For Git push or private clones, create a named Secret containing a repository-scoped
`GITHUB_TOKEN` and set `MODAL_GIT_SECRET`. The credential helper supports GitHub
HTTPS repositories only. No credentials are embedded in clone URLs. Without this
secret, the runtime can clone public repositories but cannot promise push access.

Point `BACKEND_PUBLIC_URL` to an HTTPS tunnel reaching the local API. Preserve
Authorization and invocation headers through the tunnel. Modal guests cannot use
the laptop's `localhost`. Use two different random secrets of at least 32
characters for `ADMIN_TOKEN` and `AGENT_TOKEN_SECRET`.

In separate terminals, start the Temporal service, API and worker:

```bash
mkdir -p .atoi
temporal server start-dev --db-filename .atoi/temporal.db
```

```bash
pnpm dev:api
```

```bash
pnpm dev:worker
```

The database file preserves local Temporal history across service restarts.
See the [Temporal CLI reference](https://docs.temporal.io/cli/command-reference/server).
The API also runs the outbox/reconciler. Keep both trusted processes available
for timely wakeups and cleanup. Shutdown of a local service does not automatically
terminate cloud compute; configured sandbox lifetimes remain the backstop.

## Demo sequence

Use a small repository you control with deterministic tests and a bounded issue:

```bash
pnpm cli start https://github.com/<team>/<demo-repo>.git "Fix the parser edge case, consult your reviewer and report the pushed commit and test evidence."
```

The returned response contains `run._id` and agent IDs. The CLI seeds an
implementer/reviewer pair; the API accepts other roles and up to eight agents.
Both agents receive the objective, discover peers and can message them directly.

```bash
pnpm cli status <run-id>
pnpm cli message <run-id> <agent-id> "Continue from your earlier finding and answer this follow-up."
pnpm cli stop <run-id>
```

Status exposes task records, observed agent state, completed invocation usage,
checkpoint references, events and pending/failed outbox work. Wait for the run to
reach `stopped` before treating cleanup as confirmed. Runs also stop at their
configured deadline. Turn limits or failed turns require inspection; they do not
silently declare the objective successful.

## Verification and limits

```bash
pnpm check
pnpm test
pnpm build
pnpm smoke:modal
```

`pnpm test` starts disposable local MongoDB replica sets and real local Temporal
services. First use may download those executables. Pi executes real coding and
coordination tools against scripted model responses. The harness integration test
routes a peer question/reply through the real HTTP API, transactional inbox/outbox
and Temporal, restores prior context, and confirms cleanup using a fixture sandbox.
Other checks cover claims, duplicate delivery, stale checkpoint rejection,
confirmed-result reuse, bounded turns and a Temporal worker restart.

`smoke:modal` creates one temporary real Modal sandbox with a ten-minute maximum,
uses scripted model/backend fixtures, and terminates it in `finally`. It verifies
SDK loading, native Pi tools, retained files, reattachment and session restoration
in a second guest process. It writes a local report to `.atoi/modal-smoke.json`.
An earlier runtime draft passed this check on October 11, 2026. The integrated
lockfile/image was subsequently exercised by the real-model E2E below; the smoke
command itself uses scripted inference and does not verify Atlas.

The real-cloud check below records its database mode explicitly. On October 11,
2026, it passed against the hackathon Atlas cluster in `atoi_e2e`, with two real
Modal guests and OpenAI `gpt-4.1`. Both agents completed two turns: independent
exact-commit review, peer DM/wakeup, native session restoration and retained
private file reuse. The check compares native session IDs and prior entry IDs
across checkpoints and requires a successful `read` tool result on the follow-up.
Cleanup and a new Atlas connection passed. A separate post-run inspection found
one done task, four checkpoints, both agents stopped, and no pending deliveries
or outbox records. Recorded main-agent usage was 17,652 input tokens, 2,397 output
tokens and $0.103312; this excludes Modal/control-plane costs and describes one
read-only verification task, not a cost comparison. A local replica-set run with
real Modal/inference also passed. Private Git push remains unverified.

Native session restoration was tested in a new local workspace and a second
process in the same real Modal sandbox. The full operator workflow for replacing
a lost sandbox is not wired yet; ambiguous interrupted turns require inspection.
Uncommitted files and running processes have no replacement guarantee.

Checkpoints have an explicit six-megabyte UTF-8 limit. Larger session epochs need
archiving/chunked storage before expanding the milestone. Reported usage covers
main agent model responses; strict dollar-budget enforcement and separate
compaction accounting remain future work. Task evidence is agent-reported; a
trusted evaluator has not been implemented. A `done` flag does not establish
verified success.

The planning orchestrator's spawn/completion tools,
automated sandbox replacement, semantic knowledge discovery and reuse across
completed runs remain later slices of [Milestone 1](milestone-1.md). This runtime
does not complete the entire milestone. The verified E2E stores coordination
state and checkpoints in the provided Atlas cluster; it does not host guest
compute inside Atlas.

No shared-data reset is performed automatically. Stop specific runs through the
API. For isolated local demos, choose a fresh database name and Temporal history
file rather than deleting shared Atlas records.

## Real E2E check

```bash
pnpm build
CLOUDFLARED_PATH=/path/to/cloudflared pnpm e2e
```

Requires `MONGODB_URI`/`MONGODB_DATABASE` in `.env`, Modal authentication and
`ATOI_MODEL_API_KEY` or `MODAL_MODEL_SECRET`. With OpenAI, the check can use an
existing local `OPENAI_API_KEY`; the default pinned-catalog model is `gpt-4.1`.
The script starts a real local Temporal service, authenticated API and temporary
Cloudflare HTTPS tunnel, then two real Modal/Pi workers with real inference.
It verifies a read-only task against an existing public Git commit, requires an
independent reviewer, confirms peer DMs and wakeup, then checks the implementer's
native session and retained private file on a follow-up turn. It does not prove a
new implementation commit was pushed or reviewed.

The script stops the run and terminates named guests in `finally`, reconnects to
the database, and records evidence/usage in ignored `.atoi/e2e-report.json`.
It retains Atlas test records; it never drops a shared database. The record says
whether it used an Atlas SRV URI or a local replica set. For an explicitly local
DB plus real Modal/model check, use `E2E_LOCAL_DB=1 pnpm e2e`; this never satisfies
the hackathon's Atlas requirement. It makes real model calls and incurs provider
charges, bounded by a 20-minute run and per-turn request/tool/time limits.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
are temporary development endpoints. The health probe resolves IPv4 DNS directly
to avoid stale negative system DNS caches for newly allocated tunnel hostnames;
TLS certificate verification remains enabled. Quick Tunnels do not support SSE;
use a local endpoint for CLI activity observation or a stable HTTPS endpoint for
remote consumers.

## Integration and development state

Runtime activities extend the single `CoordinationStore` business contract.
All guest coordination uses `/runs/:runId/...`, channel sequence pagination and
Ryan's versioned review transitions. Real guests require current invocation and
generation headers as well as their scoped bearer token. Model execution,
checkpoint publication and lifecycle Activities share the same `runs`, `agents`,
`deliveries`, `outbox` and `agent_events` schema. Activity API responses convert
those canonical event records into the activity DTO; no second event store exists.

The former uncommitted runtime draft used incompatible `agentId/state` deliveries
and `sent/kind=wake` outbox records. Do not run that draft against the current
schema. Use a fresh explicitly named development database for its old test data;
no automatic migration/reset deletes existing Atlas records. Databases created by
Ryan's coordination slice also need the new lifecycle/event fields before resuming
historical runs; use fresh runs for this demo.
