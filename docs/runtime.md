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
| Orchestrator | Same Pi runtime, atomic worker reservation, task delegation, independent review and checkpoint-confirmed completion |
| Recovery | Explicit replacement of idle agents at a pushed commit after terminating old execution |
| CLI/UI | Launch an orchestrator, inspect activity, message agents and stop compute; CLI also requests replacement |

Finishing a turn, task or objective leaves the same agent and sandbox available. While idle,
Temporal waits without a Pi invocation running. The sandbox stays alive and billed;
this is not VM pause or a memory snapshot. A new delivery starts a fresh worker
process in that sandbox and restores the native session checkpoint from Atlas.
Files, installed dependencies and other guest state remain in the living sandbox.

Each invocation has a stable ID and generation. The guest caches a confirmed
result and rejects overlapping/interrupted work. The harness reads that cache if
a response is lost. Unconfirmed effects become `needs_inspection`, leaving the
delivery unacknowledged; shell commands are not blindly replayed. Completed
invocations commit their checkpoint and delivery acknowledgements together.

Exhausted turn-Activity retries record `needs_inspection`, retain unacknowledged
work and do not restart the model automatically. The reconciler inspects failed
workflows if the failure-report Activity could not reach Atlas. A checkpoint
already committed for the failed Activity is reused rather than falsely marked
uncertain. Pending wakeups for an agent under inspection stay queued.

Stopping fences execution immediately, but the run stays `stopping` until every
agent has `cleanupCompletedAt` set by successful bound and named guest cleanup.
A missing sandbox binding is not proof of termination. Each provisioning attempt
is recorded before the provider call; one retry cannot clear another in-flight
attempt. Cleanup waits until all calls and compensating
terminations settle. A stuck provisioning marker requires inspection; it does not
report the run as stopped. Failed cleanup workflows remain discoverable for the
bounded reconciler retries.

## Interactive teams and arbitrary repository tasks

Use `pnpm dev:live` for the interactive app. It starts the real backend, Temporal
worker and a local Temporal service with history in `.atoi/live/temporal.db`.
It creates a Cloudflare tunnel for guest callbacks (install `cloudflared`, set
`CLOUDFLARED_PATH`, or provide `LIVE_BACKEND_URL` for your own tunnel). In another
terminal run `VITE_API_TARGET=http://127.0.0.1:3200 pnpm dev:dashboard`, then open
the printed UI URL and enter `ADMIN_TOKEN`. `LIVE_API_PORT` overrides port 3200.
The launcher stays running between objectives. `pnpm e2e` is an acceptance test,
not the interactive backend: it starts and cleans up its own isolated test run.

`complete_objective` replaces `finish_run`. After the orchestrator checkpoints,
the UI says **available for follow-ups**. Message the orchestrator to ask questions
or assign another task in the same repository; it reuses the workers, workspaces
and native sessions. A new task returns the team to **running**. Previous outcomes
remain in the event history. Completion does not reset invocation budgets or the
team deadline. Stop and the displayed team lifetime terminate every sandbox.
Idle sandboxes remain billed. There is no automatic idle suspension or reopening
of a team already stopped by the old implementation.

Any bounded coding objective can use an authorized repository, including one with
no commits. No parser fixture, TASK.md, package.json or main branch is required.
The first implementation commit goes to a new task branch and is independently
reviewed there; main/default-branch creation and automatic merging are not done.
A follow-up should build on the last reviewed commit, since main is unchanged.
Each team stays attached to one repository; start a new team for another repository.

Configure repository access in the trusted backend's `.env`:

```dotenv
GITHUB_REPOSITORIES='{"you/project-a":"project-a-git","you/project-b":"project-b-git"}'
```

Each value names a Modal Secret holding a `GITHUB_TOKEN` with Contents read/write
on that specific repository. Only that matching secret reaches its sandboxes.
The dashboard can list configured repositories without seeing secret names or
values; an unconfigured URL is rejected before a run is created. Adding a URL does
not grant GitHub permissions: first create the scoped credential/Modal Secret,
then add the mapping and restart the services. This replaces `MODAL_GIT_SECRET`.
The existing demo token grants access only to `ruining-hu/atoi-e2e-fixture`; its
contents do not restrict which objectives you can assign there.

The local launcher tags its teams with a stable identifier derived from its state
directory. Reconciliation and Ctrl-C cleanup affect only those teams. Other runs
in a shared Atlas database are visible in history but are not adopted. Graceful
launcher shutdown stops its active teams; an abrupt crash retains Temporal history
and Atlas state, but interrupted external effects still require inspection.
Keep the laptop and launcher running for callbacks and deadlines to advance.
This is a local development topology, not an always-on hosted deployment.
When agents are idle, for a controlled code reload without stopping the teams, send `SIGUSR2` to the
backend Node process, wait for it to exit, then run `pnpm dev:live` again. This
quiesces the worker and preserves Temporal history and cloud sandboxes. Ctrl-C
still explicitly stops teams. An abrupt interruption during an external command
is not safe to replay automatically.

Normal final answers to operator DMs are published to that conversation in the
same transaction as the session checkpoint and delivery acknowledgement. Explicit
`send_message` replies are not duplicated. Plain peer-turn text is not broadcast.
Chat replies are bounded to 32,000 characters; the full answer remains in the
invocation record.

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
`GITHUB_TOKEN` and map its repository in `GITHUB_REPOSITORIES`. The credential helper supports GitHub
HTTPS repositories only. No credentials are embedded in clone URLs. Interactive launches require a configured repository; the read-only smoke runner
can separately clone public repositories without Git write credentials.

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

The response contains `run._id` and the orchestrator's ID. The CLI starts the
orchestrator with capacity for two workers; an optional third CLI argument sets
one to eight workers. Its `spawn_agent` tool atomically reserves stable identities
and capacity, including pending provisioning. Duplicate spawn request IDs return
the same worker. The API's optional explicit `agents` array remains available for
seeded fixtures; normal launches omit it and use the orchestrator.

```bash
pnpm cli status <run-id>
pnpm cli message <run-id> <agent-id> "Continue from your earlier finding and answer this follow-up."
pnpm cli stop <run-id>
pnpm cli replace <run-id> <idle-agent-id> <pushed-40-character-commit>
```

Status exposes task records, observed agent state, completed invocation usage,
checkpoint references, events and pending/failed outbox work. Wait for the run to
reach `stopped` before treating cleanup as confirmed. Runs also stop at their
configured deadline. Turn limits or failed turns require inspection; they do not
silently declare the objective successful.

Default turn limits are 180 seconds, 24 model requests and 40 tool calls, configured
with `TURN_TIMEOUT_MS`, `TURN_MODEL_REQUESTS` and `TURN_TOOL_CALLS`. Hitting a limit
checkpoints the observed result and requires inspection; it does not automatically
repeat commands or mark the run complete. The real reviewer exhausted a 12-request
cap during integration, so the default allows enough room for its verification and
reporting while retaining explicit bounds.

## Verification and limits

On October 11, 2026, the full browser-launched check passed against Atlas, real
Modal sandboxes and `deepseek-ai/DeepSeek-V4.1-Flash`. Run
`3f2bc72b8e397d390e37d9a792e0b268063cbb601ec6a2523d6c98cbdcb80648`
produced reviewed commit
[`53807439933dbf81af659d783bb38b77f5c56057`](https://github.com/ruining-hu/atoi-e2e-fixture/commit/53807439933dbf81af659d783bb38b77f5c56057)
on a task branch. Only `parser.js` changed. Fixture `main` remained at
`53383bd805f11e760067007803b3c65910d37a3a`.

The run verified three real agents, an independent three-test pass, an additional
runner-executed test pass inside Modal, direct operator/worker messaging through
the UI, Temporal worker restart, a queued message across sandbox replacement,
native session identity/history restoration, final checkpoint confirmation and
termination of all guests. A fresh Atlas connection found zero pending deliveries
and outbox records; Modal listed zero active sandboxes for the run. UI refresh
replayed the completed state from Atlas.

Recorded main-model usage was 80,218 input and 15,065 output tokens over 54 model
requests and 63 tool calls. Summed invocation time was 295.8 seconds (agents ran
concurrently). Custom endpoint cost is unpriced; no cost or quality advantage is
claimed. Local checks passed: 54 backend tests, 77 dashboard tests, type/lint checks
and both builds. Adding a third worker and lifecycle failure/race cases are covered
by local provider-fixture tests, not a four-sandbox live run.

Earlier attempts exposed and fixed legacy coordination records blocking the relay,
Modal's sandbox name-length limit for dynamic IDs, and insufficient review turn
budget. An earlier successful API-launched run needed one operator-recipient
clarification; the final browser run completed recovery without that correction.
Detailed local evidence is in ignored `.atoi/e2e-report.json` and
`.atoi/verification-summary.json`.

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
confirmed-result reuse, bounded turns and a Temporal worker restart. Lifecycle
failure regressions use real MongoDB/Temporal with provider fixtures to exercise
unbound named guests, failed cleanup retry, provisioning/stop races, overlapping
provisioning attempts, exhausted turn retries, failed failure reporting, lost
completion acknowledgement and empty logical runs.

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
real Modal/inference also passed. This earlier check was read-only; the writable
fixture below now also verifies a new implementation push.

Operator-requested replacement is wired through Temporal and has local provider-fixture
regression tests. It requires an idle agent with a confirmed checkpoint, fences new
invocations, stops the old guest, checks out the requested pushed commit and retains
pending messages. The next invocation restores native Pi state. Ambiguous interrupted
turns require inspection. Uncommitted files, post-image dependency installations and
running processes have no replacement guarantee. This is not a RAM snapshot.

The orchestrator's `complete_objective` requires all tasks to have independent approval of
their exact submitted commits. Completion records intent, waits for the orchestrator's
checkpoint, then leaves the team available until explicit Stop or its deadline. Guest task submission verifies that the
commit is reachable from a fetched origin branch; guest review also requires that
exact commit checked out. These checks do not make agent-reported test notes trusted
evaluator results.

Checkpoints have an explicit six-megabyte UTF-8 limit. Larger session epochs need
archiving/chunked storage before expanding the milestone. Reported usage covers
main agent model responses; strict dollar-budget enforcement and separate
compaction accounting remain future work. Task evidence is agent-reported; a
trusted evaluator has not been implemented. A `done` flag does not establish
verified success.

Automatic recovery decisions, semantic knowledge discovery and reuse across completed
runs remain future work. Atlas stores coordination and checkpoints, not guest compute.

No shared-data reset is performed automatically. Stop specific runs through the
API. For isolated local demos, choose a fresh database name and Temporal history
file rather than deleting shared Atlas records.

## Real E2E check

Set `E2E_REPOSITORY` to an authorized disposable parser fixture containing `parser.js`,
`parser.test.js`, `package.json` and `TASK.md`, such as the private
`ruining-hu/atoi-e2e-fixture`. The intentionally broken `parseInteger` must reject partial
numbers, accept signed safe integers and trim whitespace. Add it to `GITHUB_REPOSITORIES` with a
named secret containing a `GITHUB_TOKEN` granted Contents read/write only on that repository:

```bash
pnpm build
E2E_REPOSITORY=https://github.com/<you>/<fixture>.git CLOUDFLARED_PATH=/path/to/cloudflared pnpm e2e
```

This mode requires an orchestrator to spawn two real workers, push a new task branch,
obtain independent review of that exact commit and wait for an operator message. The
runner checks actual passing test output, independently executes the suite in the
reviewer's Modal sandbox, and verifies that test files and task instructions were not
changed. It then restarts the Temporal worker, replaces the idle implementer's sandbox,
checks a message queued while the worker was down, and compares native session entry
IDs before/after replacement. It authorizes objective completion, confirms the team
remains active, then assigns a different documentation task to the same agents and
independently checks its pushed commit. Explicit Stop must clean up every guest.
The API-launched run is bounded to 40 minutes and 30 invocations per agent and incurs
real provider usage. It leaves the reviewed branch
for inspection; no automatic merge occurs.

To exercise the browser launch as part of the same acceptance check, start these
in separate terminals (with `E2E_REPOSITORY` and credentials already in `.env`):

```bash
E2E_API_PORT=3200 E2E_LAUNCH_FROM_UI=1 pnpm e2e
VITE_API_TARGET=http://127.0.0.1:3200 pnpm dev:dashboard
```

Wait for the runner's browser-launch prompt, then open the Vite URL and launch
with the configured fixture repository, two workers, a 40-minute limit, and the
exact `fixtureObjective` exported in `scripts/e2e-orchestration.ts`. Browser launches
use the API's default cap of 20 invocations per agent. The runner
observes that new run and performs review/recovery checks. Its scheduler handles
only that run, so existing Atlas demo records are not adopted or reset. The test
uses temporary Temporal history and shuts its API and tunnel down afterward;
use the persistent service setup above for ongoing development.

For a custom compatible chat-completions endpoint, configure `PI_BASE_URL` including
`/v1`, an arbitrary `PI_PROVIDER` name, the endpoint's `PI_MODEL` and its bearer value
in `ATOI_MODEL_API_KEY`. The adapter registers it with the pinned Pi SDK. Tokens are
recorded but cost is **unpriced** until provider pricing is configured. Inference
endpoint credentials do not authorize sandbox creation: the control plane also needs
Modal management authentication, which is never injected into guests.

Without `E2E_REPOSITORY`, the earlier read-only two-worker check remains available:

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
historical runs; use fresh runs for this demo. Cleanup confirmation and in-flight
provisioning markers are new fields; historical stopped records do not establish
these new guarantees. The admin registration endpoint accepts only logical
agents (`runtimeEnabled` omitted or false). Runtime agents are seeded through
`/operator/runs`, which generates the same scoped credentials used by the guest.

New dashboard events carry immutable task/message snapshots. Start fresh demo runs
when upgrading: old histories do not contain every snapshot needed for full visual
replay. Existing data is never reset automatically. Browser live transport polls
persisted event pages with Bearer authentication; the CLI retains its SSE transport.

## Follow-up and general-task validation (October 11)

The updated real cloud acceptance run `ace69accf02a9af2b51d6b799550c34325321caa2698484c3d34e7da0f572479`
passed: the same three agents completed the parser objective, recovered from worker
restart and sandbox replacement, then completed a new USAGE.md objective after
checkpoint-confirmed completion. Explicit Stop cleaned every sandbox.

A separate Chrome launch on the interactive backend created a standalone slugify
utility and tests, without changing the parser fixture or main. Independent guest
verification of commit `9438071a40c0f90cb312667169bea5691ba4bbb1` passed all eight
slugify tests. Its team remained active after completion, survived an idle backend
restart with persistent Temporal history, and answered a normal operator follow-up
from its retained session. Browser inspection confirmed the answer in chat.

Empty-repository bootstrap is verified locally using the exact guest initialization
script: two private clones, the first pushed task-branch commit, independent exact
checkout and execution, and no main branch. An entirely empty GitHub repository
has not yet been exercised in Modal. New repositories still need scoped credentials.
