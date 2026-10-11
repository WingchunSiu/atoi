# Milestone 1 Orchestrated collaboration across cloud sandboxes

Build a working vertical slice of the harness: an orchestrator spawns a configurable team of persistent Pi agents in separate Modal sandboxes. Temporal durably schedules their work; MongoDB Atlas holds shared state. They exchange code through Git and complete a small implementation and review task. The first end-to-end test uses two workers plus the orchestrator, for three agents total. The architecture must support more workers without changes to schemas or routing.

## Scope

The web app starts a team run with an objective, repository and configurable worker limit. The backend durably accepts the request and returns a run ID; Temporal provisions the orchestrator asynchronously. The orchestrator assigns initial roles, spawns workers, seeds tasks, monitors progress and assesses completion. All agents can create and claim tasks, post to the team channel, and DM each other. Roles guide behavior without restricting peer communication. The CLI uses the same API for debugging and smoke checks.

The initial fixture uses an implementer and reviewer against a small repository with deterministic tests and a bounded change, such as fixing a parser edge case. These are fixture roles, not hard-coded worker slots. The orchestrator can add workers during a run within its configured limit. Worker-initiated spawning is deferred.

Task completion leaves an agent available for follow-up within the run. Run completion archives records and checkpoints and stops all run compute. Reusing the same team across completed runs is deferred. The milestone proves continuity across turns, tasks and sandbox replacement, rather than indefinite lifetime of a physical sandbox.

## Architecture

| Component | Implementation and responsibility |
| --- | --- |
| Coordination backend | TypeScript, Node.js, and Fastify; task and messaging APIs, admission limits, outbox relay and event log |
| Durable scheduling | Temporal service and TypeScript worker outside sandboxes; run supervisor, per-agent workflows, timers, retries, cancellation and lifecycle Activities |
| Shared state | MongoDB Atlas through the official Node driver |
| Planning orchestrator | Pi agent in its own Modal sandbox; role assignment, worker spawn requests, task seeding, progress checks and final assessment |
| Agent worker | TypeScript process embedding the Pi coding-agent SDK; one serialized conversation per agent |
| Execution | One Modal Sandbox per agent, using a common image with Node.js, Git, and the worker |
| Project storage | One hosted Git remote; independent clone and task branch in each sandbox |
| Operator interface | React/Vite/Tailwind web app; launch/stop runs, team conversations, tasks, evidence and persisted events; CLI for smoke checks |

The planning orchestrator reasons about the objective. The trusted control plane enforces authorization, capacity, deadlines and cleanup. Fastify and the Temporal worker are ordinary services, not agents, and do not run inside an agent-controlled sandbox. They can run locally for development or on a hosted server; their process identity is not the agent's identity. See [deployment boundaries](deployment.md) for both topologies.

Workers call authenticated backend APIs using credentials scoped to their run and agent. The backend and trusted Temporal worker hold the control-plane credentials; sandboxes receive no Atlas, Modal or Temporal credentials. Each sandbox receives Git access scoped to the demo repository. Agents receive file and shell tools plus custom coordination tools.

The main harness comprises Fastify, the trusted Temporal worker and the outbox/reconciler. It owns all application Atlas access and Modal provider API calls. Agent coordination, events and checkpoints pass through this backend system; agents never query Atlas or invoke a peer sandbox directly. The Temporal worker can use provider SDKs directly within this boundary. Model calls and Git access from guests are separate from coordination traffic; a gateway for those is outside the initial design.

Git is authoritative for project files and artifacts. Atlas is authoritative for task state, mailboxes, agent records and session checkpoints. Temporal owns durable scheduling and lifecycle decisions, using its own service and history store; Atlas is not its persistence backend. Repository metadata in Atlas references commits and paths rather than duplicating the working tree.

## Shared state and tools

Use separate documents for messages, deliveries, and events rather than unbounded arrays.

| Collection | Minimum contents |
| --- | --- |
| `runs` | Start request ID, objective, repository, orchestrator ID, supervisor workflow ID, worker limit, status, and execution limits |
| `agents` | Run, role, stable workflow ID, sandbox reference, invocation generation, heartbeat, and session checkpoint reference |
| `tasks` | Description, acceptance criteria, status, owner, dependencies, and result commit |
| `channels` | Run and participants; one team channel and peer DMs |
| `messages` | Sender, channel, body, reply reference, and client request ID |
| `deliveries` | Recipient, message reference, processing status, and claim lease |
| `outbox` | Durable workflow-start, wakeup and completion notifications with retry status |
| `invocations` | Stable invocation ID, agent generation, status, checkpoint and uncertain-effect details |
| `session_checkpoints` | Versioned Pi session data and the last completed delivery |
| `agent_events` | Lifecycle, tool activity, and verification outcomes |

Expose `list_agents`, `create_task`, `list_tasks`, `claim_task`, `update_task`, `send_message`, and `read_channel`. Task states are open, in progress, blocked, in review, and done. The backend validates ownership and transitions. Claims use a conditional atomic update; competing claims produce exactly one owner.

The orchestrator additionally receives `spawn_agent` and `finish_run`. Spawning accepts a role, instructions and request ID; the backend reserves a stable agent record and queues a workflow-start outbox event before provisioning. A Temporal Activity provisions the sandbox. Retried requests reuse that record. Admission is atomic against the worker limit, including pending provisioning, and partial failures remain visible for reconciliation. Only the trusted control plane holds Modal credentials.

Store agents as run-scoped records and address messages by agent ID. Team membership grows as workers join; DMs support any peer pair. Task ownership and delivery use IDs rather than implementer/reviewer-specific fields. Apply limits to the whole run, and stop every sandbox recorded for it, including the orchestrator and partially provisioned workers.

The orchestrator reads task and verification results before calling `finish_run` with the final commit and outcome. The backend checks required tasks are done and have recorded verification against that exact pushed commit, then durably queues completion. An agent's unsupported success claim is insufficient. Normal completion waits for the orchestrator invocation to checkpoint and finish, then the run supervisor stops the run's agents and records cleanup outcomes. A failed or overdue final checkpoint becomes an explicit failure and cannot prevent bounded cleanup. The orchestrator need not relay ordinary peer exchanges. This milestone does not establish large-swarm performance.

For this milestone, task ownership survives a disconnect. The operator can explicitly reassign abandoned work; automatic reassignment is deferred.

## Durable lifecycle and recovery

Create one deterministic Temporal supervisor with stable ID `run/<runId>`. It starts the orchestrator through Activities, waits for completion requests, cancellation or the run deadline, and drives idempotent finalization and resource cleanup. The supervisor is application code, not an LLM agent. Reconcile provisioned resources from Atlas so cleanup includes partial starts and still works if the orchestrator sandbox fails. Provisioning must check the run is active; a resource created during a stop race is recorded and cleaned up rather than admitted into a closed run.

Create one Temporal workflow with stable ID `agent/<agentId>` for every agent, including the orchestrator. The workflow serializes bounded invocations and waits for mailbox notifications or timers between them. Pi remains inside Modal; the Temporal worker is a separate control-plane process. Peer waits happen in the workflow, without holding a Pi invocation open or polling from the sandbox.

Keep workflow code deterministic. Atlas access, sandbox provisioning, invoking the remote Pi worker, checkpoint publication and sandbox lifecycle operations run in Activities with explicit timeouts, bounded retries, cancellation and heartbeats. Workflow payloads contain IDs and small references rather than transcripts. Use Continue-As-New as histories grow, preserving pending references and keeping message deduplication in Atlas.

Persist each message, addressed delivery and outbox event in one short Atlas transaction before acknowledging a send. The relay retries workflow notifications; a reconciler scans unsent events and pending deliveries after failures. Atlas writes and Temporal signals are not atomic together. Signals are wakeups; Atlas remains the durable inbox. DMs and explicit mentions wake recipients, while other team messages remain readable. Workflow-start notifications use stable IDs so retries find the existing agent workflow.

Before each Pi invocation, claim its deliveries and assign a stable invocation ID and generation. Retries inspect that invocation before starting work again. The sandbox worker must reject overlapping invocations and reuse a confirmed result for the same ID. Persist native Pi session data and conditionally publish the checkpoint with delivery completion in Atlas. Use chunked data if needed, publishing the manifest only after its contents are durable. Delivery is at least once, not exactly-once execution of shell commands. If the worker disappears after an unconfirmed external effect, mark the invocation for inspection instead of automatically rerunning it. Stop or isolate superseded execution before allowing replacement work.

An idle agent retains its identity, mailbox and checkpoint while its workflow waits. Quiesce tools and checkpoint before suspending execution. Verify Modal's supported pause/resume or snapshot lifecycle in the integration spike; do not assume process-memory retention or zero idle cost. Runs are assumed to remain below 24 hours; proactive lifetime rotation is out of scope. Configure an explicit sandbox timeout for the run budget rather than relying on [Modal's five-minute default](https://modal.com/docs/guide/sandboxes). If suspension is unavailable, explicitly report whether idle compute is retained and billed or replaced from checkpoint, and its recovery limits. The Temporal service and worker must be available to advance wakeups; a stopped worker delays progress until restart.

On sandbox replacement, restore the latest checkpoint, clone the repository, fetch the last pushed work, and resume pending deliveries. Uncommitted files and running processes are outside this milestone's replacement guarantee. Run completion, cancellation and deadlines initiate idempotent cleanup of all agent workflows and sandboxes, including partially provisioned resources. Persist failures so reconciliation can retry cleanup.

## Web interaction

Keep one run page with an objective/repository/limits form, team channel and peer conversations, task list, agent lifecycle states, and recorded verification with links to the exact Git commit. The operator can send a message to the orchestrator or a peer and stop a run. Operator identity is distinct from agent identity; authenticated APIs validate run access and message recipients. A run-detail view restores from Atlas after reload; the browser is not an authoritative inbox or scheduler.

Use a cursor-based persisted event feed, initially SSE, to update the page. Reconnects replay missed events and deduplicate by event ID. Show model/tool activity, result evidence, and observed sandbox state rather than inferred animation. Closing the tab or dropping its connection does not cancel work. CLI commands exercise the same endpoints. Public deployment and elaborate visualization are not required for this milestone.

## Demonstration flow

1. Start the web app, backend, Temporal service and Temporal worker, with a backend URL reachable from Modal. Launch a run in the browser with the objective and a two-worker limit. The orchestrator spawns an implementer and reviewer and seeds the task list; display their recorded events.
2. The implementer claims an available task, creates follow-up tasks as needed, makes the change, and runs the fixture tests.
3. It pushes its branch, records the commit and verification notes, and marks the task in review.
4. It DMs the reviewer with the task ID and commit SHA. The reviewer fetches that exact revision, runs checks, and reports its findings.
5. If changes are needed, the agents exchange feedback and a new commit. On approval, the reviewer marks the task done. The deliverable is a reviewed branch; merging to the default branch is deferred.
6. Checkpoint the reviewer and let its workflow wait. Wake it through a DM and a timer in separate checks. Restart the Temporal worker and verify pending work resumes without overlapping Pi invocations. Then replace the reviewer sandbox, queue a follow-up while it is offline, and verify restored context and delivery.
7. The orchestrator checks task outcomes and verification evidence, reports the final commit and requests run completion. After the orchestrator checkpoints, Temporal cleans up all run sandboxes and the backend exposes the recorded result.
8. In separate checks, refresh/reconnect the browser without stopping the run, then stop a run with an unavailable orchestrator. Verify bounded cleanup and visible failures; the planning agent is not required for operator cancellation.

## Acceptance criteria

- The orchestrator spawns two workers through real tool calls; all three agents execute Pi in separate Modal sandboxes.
- A focused additional smoke check allows a third worker, verifies peer discovery and messaging, and confirms it can claim a task without code changes.
- Retried spawn requests do not create duplicate logical agents; concurrent requests cannot exceed the configured worker limit. Partial provisioning failures are visible and cleaned up.
- A concurrent claim check gives exactly one agent ownership of a task.
- Team chat and DMs persist, with DMs delivered only to their participants.
- The reviewer fetches the advertised commit and records actual test results.
- Retrying a send with the same request ID creates no duplicate message or delivery for that recipient.
- Messages and timers wake idle workflows; restarting the Temporal worker preserves pending work and serialized invocations.
- A failed outbox relay is reconciled; duplicate signals do not apply a completed delivery twice.
- An Activity retry after a confirmed checkpoint reuses the result; ambiguous interrupted effects are reported rather than blindly replayed.
- Replacing a sandbox preserves checkpointed context and pending messages; committed work is recoverable from Git.
- Record observed Modal idle/resume behavior and recovery limits; distinguish workflow persistence from sandbox memory retention.
- The web app starts a run, sends an operator message, shows the full handoff, final commit, actual review evidence and recovery failures, and can stop the run. Refresh/reconnect recovers persisted state and events; tab closure does not cancel work.
- Retrying a start request returns the same logical run. The CLI uses the same API and provides a reproducible smoke path.
- The run has a configurable deadline and turn limit; stopping or completing it cleans up every sandbox in the run, including when the orchestrator fails. Interrupted checkpoints and failed cleanup are visible and reconciled.

Completion requires an observed end-to-end run plus focused checks for spawn limits and retries, claim contention, duplicate messages, outbox reconciliation, Temporal worker restart, Activity retry handling, checkpoint recovery, browser reconnect and cancellation without the orchestrator. Worker-initiated spawning, automated merging, semantic search, large-swarm load testing, reusable teams across completed runs and elaborate UI features belong to later milestones. The [first runtime slice](runtime.md) implements and checks some foundations; it does not complete this milestone. Its fixtures and unverified cloud integrations are documented separately.
