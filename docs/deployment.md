# Web app and deployment boundaries

atoi is a web app backed by durable coordination services and a team of Pi agents.
Start with a local control plane and real cloud agents. Host the control plane when
the demo needs to continue without a developer's laptop. Neither topology changes
the agent runtime or requires a new orchestration design.

This is the deployment design. The backend, Temporal worker and Modal/Pi runtime
now have a first implementation; the browser client and hosted deployment remain
planned. See [runtime status and verification](runtime.md) for the exact limits.

## Two meanings of orchestration

| Component | Responsibility | Execution location | Durable state |
| --- | --- | --- | --- |
| Planning orchestrator | Reason about the goal, seed tasks, request workers, consult peers, assess evidence | Pi in its own Modal sandbox | Agent records and native Pi checkpoints in Atlas; pushed work in Git |
| Fastify backend | Authenticate requests, validate tools, claim tasks, reserve capacity, persist messages and outbox | Trusted local or hosted service | Atlas |
| Temporal worker | Execute deterministic workflows and external Activities, including sandbox invocation and cleanup | Trusted local or hosted service, outside agent sandboxes | Workflow history in the Temporal service; application records in Atlas |
| Temporal service | Retain history and timers, queue workflow and Activity tasks | Local development service or separately operated/managed service | Its own persistence, separate from Atlas |

The planning orchestrator is a persistent logical agent, like its peers. Its
sandbox can be replaced while its identity and checkpoint remain. It does not
need an always-running model invocation. Fastify and the Temporal worker do not
need their own agent identities, conversations or private agent sandboxes.

The run supervisor workflow enforces deadlines, cancellation and cleanup even if
the planning agent fails. Per-agent workflows serialize turns and wait for inbox
notifications or timers. All database, network, Pi and Modal operations happen in
Activities when invoked from workflow code. Fastify handlers can perform short,
validated Atlas operations directly; HTTP requests do not wait for entire agent
turns. Backend validation remains authoritative when an agent asks to spawn a
worker or finish a run.

[Temporal's worker documentation](https://docs.temporal.io/workers) explicitly
separates worker processes from the service: Temporal Cloud does not execute our
workflow or Activity code. We still operate a worker, locally or on a server.
Restarting it can resume workflow history; application retries still require
invocation deduplication and reconciliation.

## Main harness owns system API traffic

Treat Fastify, the Temporal worker and the outbox/reconciler as one trusted backend
system with separate process responsibilities. All application access to the Atlas
hackathon cluster and all Modal provider API calls belong to this system. The
browser and guest agents never use those provider credentials or connect directly
to Atlas. The Temporal worker can use the Modal SDK and shared Atlas repositories
directly; central control does not require another HTTP hop through Fastify for
every Activity.

```text
Browser <--> Harness API <--> Atlas cluster
                 ^
                 | authenticated tools, events and checkpoints
                 v
             Pi in Modal

Harness Temporal worker <--> Modal provider API
Harness Temporal worker <--> Temporal service
```

Agents request actions through narrow tools such as `send_message`, `claim_task`
and `spawn_agent`. The backend validates identity, ownership, limits and request
IDs, then persists accepted actions. A peer message goes to Atlas and the outbox;
Temporal wakes the recipient and an Activity invokes its sandbox. The sender does
not call the recipient's sandbox directly. Tool results and session checkpoints
return through authenticated backend endpoints or trusted Activity collection.

This boundary covers coordination, persistence and sandbox lifecycle traffic.
Pi's model calls and Git operations currently use scoped access from the sandbox.
Routing those through a backend model gateway or Git broker is a separate choice,
not implemented here. Do not claim that this design proxies or restricts all guest
network traffic. The harness governs agent actions through schemas and durable
records rather than exposing arbitrary database queries or provider calls.

## Local development and first demo

```text
Browser: React web app
    | authenticated HTTP + persisted event feed
Laptop: Fastify API + outbox/reconciler
    | Atlas writes + Temporal requests
Laptop: Temporal service (persistent development store) + trusted worker
    | Modal SDK: provision, invoke, inspect, checkpoint, stop
Cloud: orchestrator sandbox + worker sandboxes, each running Pi
    | authenticated HTTPS coordination API; scoped Git/model access
Cloud: Atlas accessed only by the harness; hosted Git accessed by agents
```

Cloud sandboxes cannot reach the laptop through `localhost`. Expose the backend
through an HTTPS development tunnel and inject its reachable URL into the sandbox
worker. Keep the tunneled API authenticated; operator and agent credentials have
different scopes. The browser can use a local development proxy to the same API.
Verify both sandbox-to-backend calls and worker-to-sandbox invocation in the first
integration check.

The browser submits a bounded objective and receives a run ID after durable
acceptance. It reads tasks, conversations, evidence and lifecycle events from the
backend. Work continues asynchronously when the tab closes. Use persisted event
IDs and a replay cursor for reconnects; neither the event connection nor the
browser's memory owns a run.

The laptop must remain awake for this topology to make progress. When the backend
or Temporal worker is offline, coordination is delayed, while a live sandbox can
still be running and billed. Provider timeouts remain a backstop; application
deadlines and cleanup only advance once the trusted services recover. Preserve
the local Temporal service's history across restarts; an in-memory demo server
would not prove crash recovery.

## Hosted demo

Use one small trusted host for Fastify and a separately supervised Temporal worker
process. Fastify can serve the built web assets at the same origin, keeping the
first deployment simple. A static frontend on another host is optional. Use a
separate durable Temporal service, either managed or self-hosted, and keep Atlas,
Modal sandboxes and Git unchanged. Choose the host and credentials when deploying;
this design does not require public deployment now.

The Temporal worker needs a host that supports a continuously running process and
network access to Temporal, Atlas and Modal. A static site host alone is
insufficient. Restart the API and worker independently, and preserve the same
database, namespace, task queue and logical workflow IDs. Moving the control plane
does not migrate or recreate agent identities.

Before exposing a hosted demo, implement operator authentication and run-scoped
authorization. Browser requests go through Fastify. Atlas, Modal and Temporal
credentials stay in the trusted services; guest workers receive only scoped
coordination and model/Git access. See [engineering rules](../AGENTS.md).

## Persistence and sandbox lifecycle

Task completion is different from run completion. During a run, an agent keeps
its inbox and checkpoint between turns and tasks. A workflow can wait without an
open model call. At run completion, archive its records and checkpoints and stop
its compute. Reusing the same team across completed runs remains a later milestone.

For the current prototype, assume each run stays below Modal's 24-hour maximum;
proactive sandbox rotation is outside scope. Still configure an explicit sandbox
timeout for the run budget instead of relying on the
[five-minute default](https://modal.com/docs/guide/sandboxes). An active command
counts as activity, so a waiting worker process must not be assumed to trigger
automatic idle shutdown. Recovery checks concern unexpected failures, not aging
past the provider's maximum lifetime.

The baseline recovery contract is native Pi session data in Atlas plus pushed
Git revisions. Uncommitted scratch files, installed changes and process memory
are not restored by that contract. The integration spike may add filesystem
snapshots after checking the pinned SDK. Modal's
[snapshot documentation](https://modal.com/docs/guide/sandbox-snapshots) distinguishes
filesystem snapshots from alpha memory snapshots, which have eligibility and
restoration limits. Do not equate checkpoint recovery with full VM pause/resume.

## Implementation boundaries

Keep separate entry points for the web client, Fastify backend, trusted Temporal
worker and sandbox Pi worker. Share validated API types and small data references;
do not import agent execution into browser handlers or deterministic workflows.
Keep the CLI as a client of Fastify, rather than a second coordination engine.

A small initial source layout can express these boundaries without a plugin system:

```text
web/                 React client
src/api/             Fastify routes, authentication, outbox/reconciler
src/temporal/        Workflow definitions and trusted Activities
src/agent/           Sandbox entry point, Pi session handling, coordination tools
src/contracts/       Validated wire schemas shared by clients and services
src/store/           Atlas repositories used only by trusted services
```

The backend/runtime directories now exist; the browser UI is developed separately
against the backend APIs. Build the sandbox
worker from its own entry point; it must not bundle the backend or trusted credentials.
Keep workflow definitions separate from Activity implementations so deterministic
workflow code does not import database or sandbox clients.

Document configuration for the backend's public URL, browser API/proxy URL, Atlas
connection and database, Temporal endpoint/namespace/task queue, Modal credentials
and image, scoped Git/model access, and run budgets. The current names and pinned
SDK versions are documented in [runtime setup](runtime.md) and `.env.example`.
Maintain separate health indicators for API availability, Temporal worker
availability and observed sandbox state; the current health endpoint reports only
API availability.

Acceptance checks are in [Milestone 1](milestone-1.md). Public hosting is optional;
real peer collaboration, recovery, browser reconnection and cleanup are required.
