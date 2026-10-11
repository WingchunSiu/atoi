# Orchestration and personal tasks

## Structure

A run starts one planning agent with the same Pi runtime, native session handling,
filesystem/shell tools and shared collaboration prompt as every worker. The
orchestrator has additional `spawn_agent` and `finish_run` tools. It decides whether
peers help, and generates their roles and task instructions dynamically. Worker
capacity can be zero. There are no implementer/reviewer slots, fixed peer pairs or
role-based restrictions on communication.

Workers can discover and consult any peer directly and reply to the human requester.
The API's reserved `operator` principal distinguishes authenticated human input from
agent identities. It does not impose a communication hub or a planning role.
The remaining deliberate structure is one orchestrator per run: workers cannot spawn
new peers or end everybody else's run. Worker spawning remains outside this slice.

Tasks are optional tracking records, not a mandatory coding pipeline. An agent may
claim a task and call `finish_task` with a summary and optional evidence, then end
its turn and remain available for follow-up. Dependencies default to empty. Supplying
`reviewerId` requests peer review instead of direct completion; an assigned review
cannot be bypassed and must check the exact commit when one was submitted. Git
repositories, result commits and verification notes are optional for non-code work.
Code fixtures still request independent review as part of their acceptance criteria.
Evidence and completion assessments are agent reports, not trusted evaluator scores.

## Durable admission and lifecycle

`POST /operator/runs` accepts a request ID, objective, optional HTTPS `repositoryUrl`,
`workerLimit` (0–8, excluding the orchestrator), lifetime and per-agent turn limit.
It reserves the orchestrator, team membership, objective delivery and workflow-start
outbox records atomically. Identical start retries return the same team.

`spawn_agent` accepts role and instructions; its tool-call ID becomes a stable
backend request ID. Admission atomically reserves worker capacity, identity,
team membership, initial delivery and workflow-start outbox. Identical retries reuse
the agent; changed input conflicts. Pending and failed provisioning consumes capacity,
so concurrent spawns cannot exceed the limit. Provisioning occurs only in trusted
Temporal Activities. Provider failures remain visible for inspection and cleanup.

`get_run` exposes limits and state. `schedule_wakeup` stores a durable self-timer
(1–3600 seconds, before the run deadline, at most five pending per agent). Temporal
waits until a timer/message; no open model call or sandbox polling is needed.
The timer becomes an addressed message transactionally on the next turn. Task
submissions, completion and blockers notify the orchestrator without model polling.

`finish_run` records an outcome and optional evidence/final commit. All recorded
tasks must be done and explicitly requested reviews resolved. A supplied final
commit must reference a recorded task result; no commit is needed for a general
answer. The run becomes `completing`, freezing new tasks, messages and spawns.
Only the accepted final invocation can continue uploading activity and publish
its checkpoint. The supervisor waits for that checkpoint before fencing agents and
queuing cleanup for every sandbox. It fails and still cleans up on a failed,
ambiguous or overdue final checkpoint (bounded by 12 minutes and the run deadline).

`stopping` means cleanup is outstanding. Terminal `completed`, `failed` or `stopped`
is published only after cleanup of every recorded agent is confirmed. Records and
native checkpoints remain in Atlas. Completion of one task is separate from ending
the run. Agent continuity remains scoped to a run; cross-run personal teams and
VM suspension are not implemented. Idle guests remain alive and billed.

## Development migration

Breaking start API change: replace `agents: [{role, instructions}, ...]` with
`workerLimit`. Give desired work and acceptance criteria in the objective; the
orchestrator chooses workers and instructions. Rebuild the guest bundle and restart
the API and Temporal worker together. Do not upgrade a worker servicing old workflow
histories in place: use fresh run IDs and a dedicated new development task queue or
Temporal namespace. Explicitly stop existing runs first; no data is automatically deleted.

The task result schema now requires only `summary`; `commit`, `verification` and
`evidence` are optional. `finish_task` uses the existing versioned task PATCH, and
workers stay available after completion. Existing code-review callers continue to
submit a commit and reviewer when their task needs one. A completed run exposes its
outcome in `run.completion`; run status has new `completing`, `completed` and `failed`
values. The dashboard now has a live backend adapter and a loopback operator gateway;
see [dashboard setup](../dashboard/README.md). Offline fixtures remain available.

```sh
pnpm build
pnpm cli start - "Compare options and return a sourced recommendation" 2
pnpm cli start - "Help me plan my week" 0
pnpm cli start https://github.com/<team>/<repo>.git "Implement and independently review a bounded fix" 2
pnpm cli status <runId>
pnpm cli message <runId> <agentId> "Follow-up question"
pnpm cli stop <runId>
```

## Validation

Focused tests use real local MongoDB replica sets, HTTP, native Pi tools/checkpoints
and Temporal with explicitly scripted models and sandbox fixtures. They cover
concurrent/deduplicated admission, capability enforcement, a third worker claiming
work, optional non-code task completion, operator replies, timer wakeups, final
checkpoint ordering, failure/timeout cleanup and idempotent terminal events.
`pnpm e2e` uses real Atlas (unless explicitly set to local), Modal and model inference;
it now asks the orchestrator to spawn peers and finish the run itself. It uses a
read-only public Git fixture, so it does not verify private Git push or a new code
implementation. See runtime notes for observed integration results.
