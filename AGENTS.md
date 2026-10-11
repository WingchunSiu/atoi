# AGENTS.md

## Project

atoi is a hackathon prototype for persistent agent swarms, built around MongoDB
Atlas. A team of agents keeps its identity, expertise, conversations, tasks and
workspace across sessions. Agents can discover and consult peers who have already
investigated a problem, rather than repeatedly starting from scratch.

Each agent owns one Modal cloud sandbox with a private Git clone, dependencies,
processes and scratch files. A TypeScript worker embeds the Pi coding-agent SDK
inside that sandbox. Stable identity, messages and Pi session checkpoints persist
in Atlas outside the sandbox. Finishing a task leaves the agent available for
follow-up questions. Sandbox replacement restores checkpointed context and pushed
Git work; uncommitted files and running processes are outside the first milestone's
recovery guarantee. Verify Modal lifecycle behavior before promising pause/resume.

Use TypeScript, Node.js and Fastify for the coordination backend, the official
MongoDB Node driver for Atlas, and Modal's SDK for sandbox lifecycle operations.
The backend manages durable inboxes, task ownership, admission limits and API
connections. Use the Temporal TypeScript SDK for a durable run supervisor,
per-agent workflows, timers, retries, cancellation and sandbox lifecycle Activities.
Run the Temporal worker outside agent sandboxes. Pin SDK versions and verify real
integrations.

The main harness is the trusted backend system: Fastify, the Temporal worker and
the outbox/reconciler. It owns all application Atlas access and Modal provider API
calls. Agents use scoped backend tools for coordination, events and checkpoints;
they do not access Atlas or invoke peer sandboxes directly. Model calls and Git
access from the sandbox remain separate. Assume runs stay below 24 hours for now;
configure explicit sandbox timeouts but defer proactive lifetime rotation.

Agents communicate through a Slack-like team channel and peer DMs. Every agent
can discover peers, create tasks, claim work and update progress. Initial roles
guide behavior without restricting direct collaboration. The first milestone includes
an orchestrator agent that assigns roles, spawns workers, seeds tasks, monitors
progress and assesses completion. The web app launches a run with its objective
and limits; the backend admits provisioning requests and Temporal Activities
execute them. Keep the planning agent separate from the trusted control plane:
Fastify and the Temporal worker are ordinary services, runnable locally or hosted,
and enforce limits, deadlines and cleanup without relying on agent reasoning.

Git is authoritative for shared project files and artifacts. Agents push task
branches and exchange immutable commit references through messages and tasks.
Atlas is authoritative for runs, agents, tasks, channels, messages, deliveries,
session checkpoints and events. Temporal owns durable scheduling and lifecycle
decisions with its own service and history store; Atlas is not Temporal storage.
The live task list lives in Atlas, not Git.

The first test uses two workers, an implementer and reviewer, plus the orchestrator
(three agents total). Support a configurable number of workers from the start,
with no fixed role slots or pair-specific routing. The team completes a bounded task,
exchanging durable messages and a Git commit, and recovering checkpointed context
and pending messages after sandbox replacement and Temporal worker restart.
Include a minimal React/Vite/Tailwind web interface for launching runs, messaging
the team and inspecting tasks, evidence and lifecycle events. Retain the CLI for
smoke checks against the same backend API. Browser sessions never own run lifetime.
We reuse Pi's model/tool loop.

The first milestone preserves agents across turns, tasks and completed objectives
within a run. Objective completion records a checkpointed outcome and keeps the
team available. Explicit Stop or the run deadline stops compute; reopening stopped
teams is deferred. Distinguish this limit from the long-term
product goal of persistent teams.

Follow [Milestone 1](docs/milestone-1.md) for scope and acceptance criteria.
See [deployment boundaries](docs/deployment.md) for local and hosted topologies.

## Working style

- Optimize for a working, understandable demo and fast iteration. Prefer the
  smallest complete implementation that proves the intended behavior.
- Before starting implementation, inspect `git status` and pull the latest changes
  with `git pull --ff-only` on the relevant tracked branch. Create new feature
  branches from the updated base branch. When continuing an existing feature
  branch, fetch and integrate relevant changes from its PR base before coding.
  Preserve local work; if a fast-forward is blocked, inspect the divergence and
  resolve it deliberately rather than resetting or discarding changes.
- Read relevant code and instructions before editing. Preserve unrelated work.
- Make routine implementation decisions autonomously. Ask only when missing
  information materially changes the product, or an action exceeds the request.
- Keep changes focused. Refactor adjacent code when it makes the change simpler;
  avoid unrelated cleanup and speculative abstractions.
- Follow the project's established language, tooling and formatting. Use the
  existing package manager and lockfile once the stack is selected.
- Add dependencies only when they save meaningful implementation effort. Prefer
  one implementation and one provider before introducing plugin systems.
- Document important tradeoffs briefly. Distinguish implemented behavior,
  simulated behavior and future plans.

## Breaking changes

- Breaking changes are allowed during the hackathon. APIs, schemas, prompts,
  configuration, module layout and internal interfaces may change as needed.
- Do not ask for confirmation solely because a change breaks compatibility.
  Prefer a coherent new design over compatibility shims and parallel legacy paths.
- Update affected callers, fixtures, tests, configuration examples and docs in
  the same change. Remove obsolete code and dependencies.
- Call out breaking changes in the PR. Explain how to migrate or reset affected
  development state. Scope reset scripts to the intended development/demo data;
  do not silently delete shared or production data.
- Do not preserve old formats unless a real integration requires them.

## Branches, commits and pull requests

- Use short-lived feature branches for changes intended for the shared branch.
  Local drafts do not require creating a PR or publishing anything.
  An empty repository may be bootstrapped with one initial commit on `main`;
  subsequent shared changes should use feature branches and PRs.
- Keep each PR focused on one reviewable outcome. Small vertical slices are
  preferable to separate large infrastructure and UI changes.
- Use clear, imperative PR titles that describe the resulting behavior.
- PR descriptions should explain the problem, the change and its validation.
  Include breaking changes, setup/reset steps and material limitations when
  relevant. Include screenshots or a short recording for meaningful UI changes.
- Report checks actually run and their results. Do not claim tests passed when
  they were skipped, blocked or replaced by mocks.
- Address substantive review feedback before merging. Required checks should
  pass; explain unavailable checks and any agreed exception explicitly.
- Squash-merge PRs: one final commit per PR on the shared branch. WIP commits on
  feature branches are fine. Avoid merge commits and unrelated changes in a squash.
- Use the final PR title as the squash commit subject; summarize useful context
  in the body. Never rewrite another contributor's commits without authorization.
- Do not commit, push, open a PR or merge merely because instructions describe
  that workflow. Perform those actions when the current task authorizes them.

## Runtime and data correctness

- Run the orchestrator through the same Pi worker runtime as other agents, with
  additional spawn and completion tools. Reserve stable agent records and worker
  capacity atomically before provisioning. Deduplicate spawn requests and reconcile
  partial provisioning failures. Only the trusted control plane holds Modal credentials.
- Give each run a deterministic Temporal supervisor for deadlines, cancellation
  and finalization. It must clean up resources even when the planning orchestrator
  fails. The orchestrator requests actions through validated backend tools; it
  does not own infrastructure credentials or enforce its own execution limits.
- Use run-scoped agent IDs for discovery, channel membership, task ownership and
  routing. Worker limits are configurable and include pending provisioning. Stop
  or deadline expiry must clean up all run sandboxes, including the orchestrator.
- Run Pi and its filesystem/shell tools inside the assigned Modal sandbox. Keep
  backend execution separate from agent-controlled commands. Restore native Pi
  session entries through SessionManager, not only a copied message array.
- Give each agent, including the orchestrator, one stable Temporal workflow identity.
  Serialize bounded Pi invocations and wait for messages/timers in workflows rather
  than sandbox polling. DMs and explicit mentions create actionable deliveries;
  other group messages remain readable. Enforce channel membership on reads/sends.
- Keep workflow code deterministic. Put Atlas, Modal and remote Pi operations in
  Activities with timeouts, bounded retries, cancellation and heartbeats. Keep
  payloads small; Continue-As-New carries pending references, with deduplication
  retained in Atlas. Temporal retries alone do not make Pi tool calls durable.
- Persist messages, addressed deliveries and outbox records together before
  acknowledging sends. Relay workflow starts and wakeups with stable IDs and
  retries, and reconcile pending records after restart. Atlas writes and Temporal
  signals are not one transaction; signals notify, while mailboxes retain the work.
- Give each invocation a stable ID. On Activity retry, inspect durable invocation
  state and reuse a confirmed result. Reject overlapping sandbox invocations. Save
  native Pi state durably, then conditionally publish the checkpoint and acknowledge
  deliveries together. Mark ambiguous interrupted effects for inspection instead
  of blindly repeating external commands.
- Idle workflows wait without holding Pi calls open. Quiesce tools and checkpoint
  before sandbox suspension. Verify Modal lifecycle capabilities and report any
  fallback; do not assume RAM retention or zero idle cost. Keep the Temporal service
  and worker available for wakeups. Objective completion waits for the orchestrator's
  checkpoint and leaves the team available. Stop/deadline cleanup is idempotent
  with failures retained for retry.
- Separate stable agent IDs from sandbox, run and worker IDs. Use worker generations
  and conditional checkpoint updates to reject superseded workers. Stop or isolate
  old execution before replacement; rejecting a database write alone does not stop
  a stale process from editing files or pushing Git commits.
- Recover from confirmed checkpoints and pushed Git revisions. Surface ambiguous
  interrupted effects for inspection rather than blindly replaying shell commands.
  Configure sandbox timeouts explicitly and terminate sandboxes when a run stops.
- Claim tasks with atomic conditional Atlas updates and validate state transitions.
  Task ownership survives disconnects in the first milestone; operators can
  explicitly reassign abandoned work. Delivery leases are separate from task
  ownership. Automatic task reassignment is deferred.
- Keep authoritative task state in direct database reads and writes. Semantic
  discovery is deferred and must never determine ownership or current versions.
- Expect retries and duplicate delivery. Use idempotency keys and deduplication
  for messages and actions where needed; do not promise exactly-once external effects.
- Keep database transactions short. Never hold a transaction open during a model
  call, network request or sandbox execution.
- Treat change streams as wakeup notifications. Reconcile pending work after
  reconnects or restarts so missed notifications do not strand tasks.
- Preserve source evidence and artifact versions alongside summaries. Record
  what a memory applies to, whether it is verified and when it becomes stale.
- Keep individual agent context and swarm-wide knowledge distinct. A generated
  assertion is not automatically a verified shared fact.
- Keep shared project files and artifacts in Git, with repository, path and commit
  references in Atlas. Publish task results only after the referenced commit is
  pushed successfully. Bound Atlas documents and store messages/events separately;
  use chunked storage for session data that exceeds document limits.
- Isolate edits with a private clone per sandbox and task branches. Review the exact
  advertised commit and record actual verification results. The first milestone
  delivers a reviewed branch; automated merging is deferred.
- Put limits on concurrency, retries, peer-message hops, runtime and model spend.
  Make failures explicit rather than retrying indefinitely.
- Give goals explicit acceptance criteria, budgets and stop conditions. Record
  experiments and metric results against versioned artifacts. Validate proposed
  memory, prompt or skill improvements before promotion; agents cannot rewrite
  the trusted evaluator or call their own unverified score a success.

## Engineering and validation

- Use explicit schemas and validate external inputs and agent tool arguments.
  Return actionable errors; do not swallow exceptions or silently report success.
- Keep Atlas, Modal and Temporal credentials in the trusted control plane. Give
  sandbox workers only
  agent-scoped backend credentials and the model/Git access they require. Inject
  secrets at runtime, keep them out of source control, prompts and logs, and scope
  Git access to the demo repository. Provide an environment example with placeholders.
  Pi shares the sandbox with agent-controlled commands; do not claim those commands
  are isolated from worker credentials without an additional enforced boundary.
- Record structured events with agent, task, run and causal references. Capture
  actual messages, tool results, artifacts and verification outcomes; UI animations
  must reflect recorded activity.
- Serve the browser through authenticated backend APIs. Accept runs durably before
  returning their IDs, and execute them asynchronously. Replay persisted events
  after reconnects; refresh or browser closure must not cancel work. Cloud sandboxes
  need a reachable backend URL even when the control plane runs on a laptop.
- Track model usage, execution time and failures so the demo's claims are measurable.
- Add focused tests for consequential behavior: task claims, stale-worker rejection,
  checkpoint recovery, message deduplication and artifact verification. Avoid tests
  that merely duplicate implementation.
- Always attempt to verify completed work with tests or checks appropriate to the
  change. For code, run relevant automated tests and available type, lint and build
  checks. For documentation or configuration, run applicable lint, parsing or
  validation checks. Use integration checks for database/runtime behavior when feasible.
- If no test exists for consequential new behavior, add a focused regression test
  or reproducible smoke check. Report the exact checks and results, and explain
  any blocked or unavailable verification. Do not treat the hackathon deadline as
  a reason to skip verification entirely.
- Keep offline fixtures and explicitly labeled mock mode available. A mocked run
  does not establish that the Atlas, model or sandbox integration works.
- Update the README with reproducible setup, environment variables, seed data,
  run commands and a short demo sequence. Make development/demo resets explicit.

## Hackathon priorities

1. Have an orchestrator spawn two real Pi workers in separate Modal sandboxes
   against one small test fixture; the orchestrator has its own sandbox.
2. Demonstrate atomic task claiming, persistent group chat and direct peer messages.
3. Push an implementation commit, fetch it for review and record actual test results.
4. Verify message/timer wakeups, Temporal worker restart and checkpoint recovery
   after sandbox replacement. State limits on files, processes and interrupted effects.
5. Let the operator launch, message and stop the team in the web app, and inspect
   the handoff, final commit, review evidence and failures from persisted events.

Validate claim contention, duplicate requests and checkpoint recovery with focused
checks, including spawn retry deduplication and concurrent worker-limit enforcement.
Smoke-test adding a third worker without schema or routing changes. Bound runtime
and turns, test outbox reconciliation and Activity retry handling, and verify stop
cleans up all run sandboxes even if the orchestrator fails. Defer worker-initiated
spawning, automated merging, semantic search, large-swarm load testing and elaborate
UI features. Compare against a baseline before claiming
better cost or quality. When finishing a task, summarize what changed, how it was
checked and what remains incomplete.
