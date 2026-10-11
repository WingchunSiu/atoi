# Persistent swarm architecture

Status: proposed design, not an implemented system. Temporal is selected; Pi and
MongoDB Atlas are required. E2B is the initial sandbox candidate. Confirm provider
capabilities, SDK versions, costs and deployment details in a real integration.

## What we are building

atoi is a harness for agents that keep pursuing a goal across many invocations.
Each agent has a stable identity, private environment, mailbox and accumulated
knowledge. It can finish one assignment, pause, and later accept another without
being recreated as a new logical agent.

The product contribution is durable collaboration, memory continuity and verified
progress around an existing agent SDK. We reuse Pi's model/tool loop and Temporal's
execution engine. Building a general sandbox cloud or a new model is outside scope.

## A concrete first task

Give three agents a small application with failing tests and a fixed budget:

1. A developer diagnoses failures and changes code in its private sandbox.
2. A specialist receives a durable question, searches prior experiments and
   returns evidence and a proposed fix from its own sandbox.
3. A reviewer tests the proposed artifact using a trusted test suite and records
   the result. Integration uses an explicit artifact or commit, not shared writes.
4. All agents checkpoint and pause. A timer or new test result wakes the developer
   later; it resumes its environment and continues from the last confirmed state.

Measure trusted tests passed, regressions, cost, elapsed time and repeated failed
experiments. Compare with the same model and budget in a simpler single-agent
baseline. Persistence and collaboration are hypotheses to measure, not assumed
quality improvements.

## Components and ownership

| Component | Responsibility |
| --- | --- |
| API and event relay | Goals, mailboxes, outbox delivery, UI events |
| Temporal | Workflow decisions, timers, retries, cancellation, wakeups |
| Pi runner | Bounded execution, session restoration, tool adapters |
| MongoDB Atlas | Goals, mailboxes, memory, experiments, checkpoint refs |
| Private sandbox | Private filesystem, installed environment, execution |
| Object storage | Workspace backups, large artifacts, trace archives |
| Trusted verifier | Tests and metrics against immutable artifact versions |

Agent ID, Temporal Workflow ID, Workflow Run ID, Pi session ID, invocation ID and
sandbox ID are separate identifiers. A resumed agent keeps its identity even when
a runner restarts, Temporal rolls over, or a failed sandbox must be replaced.

Atlas is not a VM provider or Temporal's persistence backend in this design.
Temporal has its own service and history store. Do not make both systems competing
authorities for workflow decisions.

## Agent lifecycle

The normal lifecycle is:

```text
message or timer -> resume private sandbox -> restore Pi checkpoint
                -> bounded work -> verify and commit checkpoint -> pause
```

Each agent retains its sandbox binding between invocations. Do not kill the guest
after a successful turn. Changes inside an agent's environment are intentional
state; isolation is between agents rather than a clean root filesystem every turn.

[E2B documents pause/resume of a sandbox's filesystem and memory](https://docs.e2b.dev/sandbox/persistence).
Store its ID externally, configure timeout-to-pause explicitly and handle pause
failure. Memory retention is a provider capability, not the foundation of recovery.
If a provider falls back to filesystem-only restoration, restart processes from
declared state. Test filesystem persistence and process restoration separately.

Before pausing, settle or explicitly stop active tools, persist Pi state and
workspace recovery references, and record the invocation outcome. A peer question
that requires a long wait becomes durable pending work; end the invocation and
wait in Temporal instead of blocking a guest on the reply.

When a sandbox is lost, provision a replacement and restore the last backed-up
workspace and session checkpoint. Report uncheckpointed environment changes as
lost; restoring workspace files does not prove that installed packages or RAM
were recovered. Full environment backup is a separate provider capability.

Serverless here means agent compute sleeps between invocations. The prototype
still needs a Temporal service and a lightweight worker that polls its task queue.
[Temporal workers execute queued workflow and Activity tasks](https://docs.temporal.io/workers).
Scaling workers to zero requires additional wakeup infrastructure. Measure idle
costs rather than assuming paused storage and control-plane services are free.

## Temporal execution and retry boundaries

Use a long-lived entity workflow with ID `agent/<agentId>`. Keep only compact
orchestration state and references in it. Message handlers notify the workflow of
mailbox IDs; the main loop serializes invocations and waits on signals or timers.

Workflow code is deterministic. Database calls, sandbox lifecycle operations,
verification and bounded Pi execution run as Activities. Activities need explicit
timeouts, retry limits, cancellation and heartbeats where appropriate.
[Temporal retries can restart an Activity from its beginning](https://docs.temporal.io/activities);
wrapping Pi in one Activity does not make each model call or tool action durable.

Persist each tool operation with a stable operation ID, arguments, status and
result reference. On retry, reuse confirmed results. For an operation whose effect
may have happened but was not recorded, reconcile with the target system or mark
it as needing review. Arbitrary shell commands cannot be assumed idempotent.
Use sandbox commands that enforce fencing or isolate mutating attempts; rejecting
an old database checkpoint alone does not stop a stale process writing files.

Only one invocation may advance an agent's checkpoint. Use lease epochs and
conditional checkpoint updates to reject stale attempts. After a crash, acquire
a new epoch, reconcile unfinished operations and restore the confirmed Pi state.
Model calls may still be repeated if a response was lost; account for that cost.

Publish a checkpoint manifest after referenced files are durable, using a
conditional version update. Keep the previous manifest available if publication
fails. Return small references from Activities rather than large transcripts.

[Continue-As-New preserves Workflow ID while starting fresh history](https://docs.temporal.io/develop/typescript/workflows/continue-as-new).
Use the SDK's rollover suggestion, finish message handlers first and carry compact
pending-work state. Keep message deduplication in Atlas across workflow runs.

Atlas mailbox writes and Temporal signals are not one atomic transaction. Write
the message and an outbox event together, relay with retries, and periodically
reconcile undelivered work. Deduplicate by message ID. Signals are wakeups; the
durable mailbox remains available after a missed or duplicated notification.

## Pi and sandbox boundary

Initially run Pi in a trusted control-plane runner. Model credentials stay there;
the assigned sandbox executes remote filesystem and shell tools. Disable local
built-in execution paths and supply explicit sandbox adapters for every exposed
filesystem/shell tool. Test that tools cannot access the runner's filesystem.

[Pi exposes sessions, tools, compaction and a native SessionManager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).
Restore persisted session entries through the manager; copying a message array
does not restore its authoritative session tree. Persist native checkpoint data
alongside our invocation metadata. Pin a version and test a real restore before
assuming Atlas can replace Pi's local session persistence.

Each invocation has model-call, tool-call, wall-time and spend limits. Implement
and test those limits at actual SDK/runtime boundaries. Disposing a runner session
releases resources; it does not retire the durable agent.

Guests do not receive Atlas, Temporal, sandbox-provider or long-lived model keys.
Approved credentialed integrations go through a scoped broker. A complete egress
policy proxy is a separate milestone; do not claim credential isolation or egress
enforcement without inspecting and testing the actual provider configuration.

## Memory across long goals

A logical session may span many bounded Pi session epochs. It is not one enormous
prompt or one JSONL file loaded forever. Preserve links between epochs and archive
raw history externally. Start with native Pi checkpoints for short runs, then add
tested epoch rollover before making large-history claims.

Use three layers:

- Working context: current goal, constraints, recent turns and retrieved evidence.
- Durable memory: structured decisions, hypotheses, verified findings, failed
  experiments and specialist expertise, indexed in Atlas.
- Archive: raw messages, tool outputs and artifacts in chunked storage, referenced
  by source ID, version and hash. Atlas holds searchable metadata and small records.

Summaries must cite evidence. Preserve unresolved disagreements, failed approaches
and invalidation conditions. Exact reads establish current artifact versions and
task authority; vector search discovers candidate knowledge and specialists.
Shared knowledge requires a recorded verification status and provenance.

Test recall after session compaction and rollover, stale-memory rejection, source
retrieval and resumption of unresolved goals. A large archive alone does not
demonstrate coherent memory across billions of tokens. Track cumulative usage and
bounded-context quality separately.

## Learning from hard metrics

Each goal specifies a metric, acceptance threshold, budget and stop condition.
For the demo, a trusted test runner scores an immutable candidate artifact.
Record the baseline, change, model/prompt versions, score, cost and verification
evidence. Failed experiments become useful memory rather than forgotten turns.

The first learning loop is proposing a better approach, testing it and retaining
verified lessons. Later, version prompt or skill candidates and promote them only
after held-out checks against a baseline; retain rollback. This is not weight
training or evidence of general self-improvement. Protect evaluators and held-out
data from agent writes. Stop or escalate on budget exhaustion or repeated lack of
progress rather than optimizing an easily gamed proxy indefinitely.

## Atlas records and hackathon deployment

Start with `agents`, `goals`, `messages`, `outbox`, `invocations`, `operations`,
`checkpoints`, `memories`, `experiments` and `events`. Use bounded documents,
unique IDs for deduplication and conditional versions for checkpoints. Index
mailbox delivery state, pending outbox work and agent ownership. Expire transient
leases and telemetry deliberately; never apply a blanket TTL to durable memory.

Use the supplied hackathon Atlas cluster and inspect its actual tier and expiry.
[MongoDB's ephemeral cluster offering has limited retention unless claimed](https://www.mongodb.com/docs/atlas/tutorial/create-ephemeral-cluster/).
Do not assume any cluster labeled sandbox is permanent. Keep large raw archives
outside small demo clusters and document how to retain demo data.

## Acceptance checks and build order

Build one agent first, then the three-agent collaboration example. Keep provider
and SDK adapters narrow without a universal plugin system.

1. Execute one real Pi invocation through remote tools and persist its checkpoint.
   Test tool routing and denied access to runner files and credentials.
2. Pause and resume the same private sandbox. Verify a file, installed dependency
   and remembered decision; separately probe process-memory retention.
3. Wake an idle agent with a durable message and a timer. Duplicate delivery and
   a failed relay must not lose work or advance the checkpoint twice.
4. Crash a runner after a confirmed tool effect but before Activity completion.
   Recover without repeating the confirmed effect; reject stale writes.
5. Replace a lost sandbox from the declared backup and report recovery limits.
6. Force Temporal and Pi session rollover at small thresholds. Preserve mailbox
   work, goal state and evidence retrieval with bounded history/context.
7. Run developer, specialist and reviewer against protected acceptance tests.
   Record measured improvement, regressions and spend, including a baseline.

Show recorded sandbox states, peer messages, goal progress and verifier results
in the demo UI. These checks are planned; documentation lint does not establish
runtime durability, security, cloud integration or billion-token scale.
