# General swarm harness foundation

atoi is moving beyond the Atlas hackathon prototype toward a general persistent
agent harness. Each agent still uses the pinned minimal Pi SDK. The harness
provides execution, persistence and collaboration mechanisms around Pi; it does
not replace Pi's model/tool loop or require a fixed planning hierarchy.

The remote branch `codex/snapshot-hackathon-atlas-swarms-2026-10-13` preserves the
hackathon version. No database or cloud resources are reset by this change.

## First runnable swarm

Requires Node 24+, the pinned repository dependencies, and a model key. It needs
no Atlas, Temporal service or Modal account:

```sh
pnpm install --frozen-lockfile
export ATOI_MODEL_API_KEY=... # supply through your environment or .env
pnpm swarm init .atoi/first 'Create a small tested program and ask a peer to review it.' hybrid
pnpm swarm run .atoi/first/swarm.json
pnpm swarm inspect .atoi/first/swarm.json
```

`init` refuses to overwrite an existing config. Set `PI_PROVIDER` and `PI_MODEL`
before initialization to select a model supported by Pi's catalog; defaults are
`openai/gpt-4.1`. Edit the generated JSON for agent count, role instructions,
workspaces and budgets. Roles are ordinary prompts. There is no privileged planner.
Use a new run ID for a new experiment; existing terminal runs are retained.
Local agents have ordinary shell access under your account. Use a disposable
environment for work that needs a filesystem or credential boundary.

| Mode | Injected coordination | Default placement from `init` |
| --- | --- | --- |
| `messages` | Addressed durable `send_message` and inbox wakeups | Separate directories |
| `files` | Native Pi file/shell tools | One explicitly shared directory |
| `hybrid` | Both | One explicitly shared directory |

These are collaboration affordances, not access-control guarantees. All modes
retain native Pi tools. `files` starts one turn per agent; it has no filesystem
watcher or automatic notification when files change. `messages` is explicit peer
messaging, not an implementation of MPI send/receive, collectives or barriers.
Agents can use prepared Git worktrees by changing workspace paths in the config.

## Architecture decisions

The required persistent entities are native agent sessions, pending addressed
messages, invocation identities/results and task artifacts. None inherently
requires a document database or workflow engine. The new runner uses one local
filesystem and one bounded controller process. Atomic file replacement and an
exclusive controller lock replace database transactions for this deployment.
This does not provide multi-host coordination, automatic failover or NFS locks.

The sandbox provider is the owner of an execution environment, not the owner of
agent identity, message schema or model loop. The first deployment runs the
controller and peer Pi sessions in one already-provisioned environment. Locally
that is the host process; through the [Harbor adapter](../integrations/harbor/README.md)
it is Harbor's task sandbox. Harbor owns provisioning and cleanup, so its provider
adapters can be reused without copying vendor SDK code into the core.

Multiple agents in one environment already work. Independently provisioned peer
environments do not yet work in the new runner: its config explicitly rejects
multiple environments. The placement core supports those declarations, but the
transport, scoped tools, cancellation and cleanup need a real remote executor.
The injected executor seam is not itself an implementation of distributed agents.

This is deliberately a single-controller experimental system. A database becomes
useful when several controllers must coordinate concurrent durable writers. A
durable workflow service becomes useful when independent services must enforce
deadlines and cleanup through process failures. Neither is a prerequisite for
the current bounded swarm, and neither is hidden behind a mandatory core interface.

## Persistence and scheduling semantics

`src/harness/swarm.ts` runs independent Pi turns concurrently up to the configured
limit. Each agent has at most one active invocation. Every agent receives the
objective once; messages arriving during a turn wait for a subsequent turn.
Messages to an idle peer become work as soon as a concurrency slot is available.
There are no polling model calls or mandatory parent/child routing.

The controller serializes message acceptance and state updates. Each accepted
message has a harness-assigned sender, recipient, ID and causal invocation/tool
call. Repeated tool-call IDs return the same message ID and reject changed content.
The durable inbox is authoritative. A delivery is acknowledged only after its
invocation result and native checkpoint are persisted. Pending messages are
batched in acceptance order; batching can depend on concurrent execution timing.
There is no cross-agent deterministic schedule or exactly-once external-effects claim.

State is stored under `controlRoot/runId/state.json`, with native results and
checkpoints under `results/turn-ID.json`. Pi's per-agent directories retain native
JSONL sessions and confirmed invocation caches. Artifacts remain ordinary task
files; this slice does not provide artifact immutability, provenance validation,
transactional file updates or automatic Git publication. Avoid concurrent edits
to the same file unless the task supplies its own locking/versioning convention.

State files use temporary writes, file sync and atomic rename. Recovery covers
ordinary process loss on a local filesystem; full machine/power-loss durability
is not verified. A process crash leaves a controller lock containing its PID.
Check that the old process and its commands have stopped before manually removing
that run's `controller-lock` directory and rerunning the same config.

On restart an unfinished turn reuses its original invocation and checkpoint.
Pi returns a confirmed cached result if available. An unconfirmed `active-turn`
marker blocks recovery and requires inspection; deleting that marker is not a
safe automatic retry policy. Confirmed failed turns remain failed. There is no
automatic lease expiry, takeover or replay of potentially repeated shell effects.

Run-wide bounds cover turns, messages, concurrent invocations and wall time;
per-invocation bounds cover main-loop model requests, tool calls and elapsed time.
The main-loop request cap does not include Pi's separate compaction requests and
is not a dollar-spend guarantee. SIGINT/SIGTERM abort active Pi calls. Detached
commands are not guaranteed to stop; the environment owner must terminate the
environment for complete process cleanup. A dead local controller cannot enforce
its deadline; Harbor supplies an independent outer trial timeout when used.

`quiescent` means no active turns or pending messages. It does not mean the task
passed. `limited`, `failed` and `cancelled` preserve evidence and return a failing
CLI exit status. Native sessions preserve actual tool results. Reported usage
counts newly recorded assistant, compaction, branch-summary and usage entries,
including cached tokens; restored history is not charged twice. Unconfirmed
invocations and provider calls without recorded usage can still be missing.
Pricing is Pi/provider-reported, not a reconciliation against a billing invoice.

## Separate the identities

| Entity      | Meaning                                           | Lifetime and sharing                                                            |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Agent       | Stable participant in a run                       | Has its own session and serialized turns; its role is profile policy            |
| Workspace   | Directory used by Pi's filesystem and shell tools | Can be a Git clone, worktree or ordinary directory; shared access is explicit   |
| Environment | Place where agent-controlled code runs            | Can host several workspaces and agents; provider owns provisioning and teardown |
| Invocation  | One bounded Pi turn                               | Stable ID, generation, confirmed result and native checkpoint                   |

An environment is not an agent. One container with three worktrees can host three
agents; three containers can each use `/workspace`; two agents can deliberately
use the same workspace. Agent sessions must remain separate in every arrangement.

A worktree separates edits and Git branch state. It does not isolate processes,
ports, dependencies, network, credentials or arbitrary filesystem access. The
placement resolver validates declarations, not an operating-system security
boundary, and does not resolve filesystem aliases or enforce permissions.

## Implemented boundary

`src/harness/contracts.ts` describes bounded Pi invocations and results without
backend URLs, database IDs, provider lifecycle calls or orchestrator/worker kinds.
`src/harness/placement.ts` resolves explicit agent/workspace/environment assignments
to guest-local paths. `src/harness/pi-runtime.ts` executes Pi with those paths,
an injected system prompt, optional custom tools and an optional event observer.

The core retains native file/shell tools, native Pi session entries and compaction,
confirmed-invocation caching, per-agent invocation locks, request/tool/time limits,
usage and error reporting. The caller supplies a native checkpoint for a follow-up
turn; the runtime does not automatically load the previous invocation's session.
The profile's bind callback receives the native session ID and validated invocation
and placement. Observers are drained before a result is confirmed; observer
failures become explicit failed results. Observer adapters must bound their I/O.

Cancellation aborts the selected Pi invocation, without calling environment
termination. The environment owner still needs to handle background processes,
unconfirmed external effects and eventual resource cleanup. Generation fencing,
checkpoint ownership/publication and durable delivery remain control-plane duties;
the extracted Pi core alone does not implement those guarantees.

`src/agent/runtime.ts` is now the existing cloud profile's adapter. It supplies the
HTTP coordination tools, cloud-team prompt and activity reporter. The existing
Fastify/Atlas/Temporal/Modal API, dashboard, supervisor and one-sandbox-per-agent
provisioning remain operationally unchanged. They are not yet generalized to
shared environments. In particular, the Modal adapter's cancellation still
terminates a whole sandbox and must not be reused for a shared sandbox unchanged.

## Declaring placement

Paths are inside the target environment, not necessarily paths on the control
plane. Provisioning must create workspaces before running Pi.

```ts
import { resolvePlacements } from "../src/harness/placement.js";

const placements = resolvePlacements({
  runId: "example",
  environments: [{ id: "host", stateRoot: "/var/lib/atoi/sessions" }],
  workspaces: [
    { id: "frontend", environmentId: "host", path: "/work/frontend" },
    { id: "backend", environmentId: "host", path: "/work/backend" },
  ],
  agents: [
    { id: "alice", workspaceId: "frontend" },
    { id: "bob", workspaceId: "backend" },
  ],
});
```

The workspaces above may be two existing Git worktrees. The resolver does not
clone repositories, create worktrees or provision environments. To deliberately
share one directory, declare one workspace with `access: "shared"` and assign
both agents to its ID. Exclusive is the default. State roots must not overlap
declared task workspaces; session directories are namespaced by run and agent.

## Running Pi without the cloud profile

```ts
import { executePiTurn } from "../src/harness/pi-runtime.js";

const result = await executePiTurn(
  {
    runId: "example",
    agentId: "alice",
    invocationId: "turn-1",
    generation: 1,
    provider: "openai",
    model: "gpt-4.1",
    prompt: "Inspect the workspace and report your findings.",
    checkpoint: null,
    budget: { timeoutMs: 60_000, modelRequests: 8, toolCalls: 20 },
  },
  {
    placement: placements.get("alice")!,
    profile: { id: "peers-v1", systemPrompt: "Work with the available tools." },
  },
);
```

This example needs model access for the selected provider (the existing
`ATOI_MODEL_API_KEY` injection is supported). Additional runtime secrets can be
listed in `secrets` for checkpoint/result redaction. Redaction does not isolate
those secrets from shell commands running under the same account.

For a follow-up, submit a new invocation ID with `checkpoint: result.checkpoint`.
The caller owns checkpoint storage and routing. Confirmed retry identity includes
the invocation, placement, profile ID, appended system prompt and optional opaque
`cacheContext`. Change the profile ID when custom tool behavior changes. Adapters
must include additional behavior-affecting configuration in `cacheContext`.

## Remaining mechanisms

Communication mechanism, organization and placement are independent choices.
The filesystem runner now implements addressed messages and acknowledgement
semantics described above. A remote transport must preserve those semantics
without exposing another agent's credentials or relying on in-memory callbacks.

Shared filesystem access is demonstrated by the core checks. A complete shared
state protocol still needs versioned reads/writes, conflict behavior and change
notification. Filesystem access alone is not transactional shared memory. Hybrid
collaboration can exchange immutable artifact references through messages.
"MPI-style" means explicit messaging here, not native MPI compatibility.

A future shared-environment provisioner must track active occupants and in-flight launches.
Stopping one agent must quiesce its invocation; deleting its workspace or stopping
its environment requires a separate ownership decision. Reference counts alone
are insufficient while provisioning or replacement is in flight. The local runner
does not provision or destroy environments. The placement resolver alone does
not implement that lifecycle.

Tree, mesh and grouped organizations can be supplied as profiles and admission
policies. The core has no privileged planner, automatic spawning, mandatory task
review or automatic success evaluator. The existing cloud profile retains its
orchestrator policy until its supervisor and admission API are migrated together.

## Validation and limits

Run with Node 24+ and the repository's pinned dependencies:

```sh
pnpm exec vitest run tests/harness-core.test.ts tests/agent-runtime.test.ts tests/activity-reporter.test.ts
pnpm exec vitest run tests/swarm.test.ts tests/harness-usage.test.ts
pnpm check
pnpm build
```

Focused checks execute the real Pi SDK with explicitly scripted inference:
independent Git worktrees on one host, shared files with separate sessions, native
checkpoint follow-ups, injected peer tools, retry deduplication, overlapping-turn
rejection, cancellation without environment teardown and observer failure.
Placement checks cover explicit sharing, references, path boundaries and separate
guest environments using identical paths. The latter validates configuration, not
real container provisioning. These checks make no real-inference quality or
new-cloud-integration claim.

Swarm checks additionally cover native Pi artifact handoff and review, explicit
message deduplication, checkpointed replies, controller contention, total turn
limits, confirmed-result recovery without repeated shell effects, refusal of
ambiguous recovery, terminal failure retention and file-only concurrent agents.
See the Harbor integration README for its separate contract checks and unverified
container/model boundaries.

The invocation-cache fingerprint and input-token accounting changed (input now
includes cache tokens, and native compaction usage is included). Before deploying the rebuilt guest,
stop existing cloud runs using the old worker and wait for cleanup. Start fresh
run IDs after rebuilding; do not hot-replace a worker serving an old invocation.
Old records are retained, and no reset or cleanup script is run automatically.
