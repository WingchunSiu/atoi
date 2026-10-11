# AGENTS.md

## Project

atoi is a hackathon prototype for persistent agent swarms, built around MongoDB
Atlas. A team of agents keeps its identity, expertise, conversations, tasks and
workspace across sessions. Agents can discover and consult peers who have already
investigated a problem, rather than repeatedly starting from scratch.

Durable state belongs in the control plane; execution workers are replaceable.
An agent can sleep, wake on a message or task, restore its context, perform work,
checkpoint and release its worker. Persistence means recoverable state and
continuity, not an always-running process or preserved model internals.

The initial demo should prove that agents collaborate, reuse earlier knowledge
and resume unfinished work after workers are destroyed. MongoDB Atlas should be
central to that behavior: task state, mailboxes, checkpoints, evidence and traces.
Vector retrieval can help discover relevant knowledge and specialists.

We are building a thin coordination runtime and an initial agent loop. Keep
integration boundaries clear so other harnesses can be supported later. Universal
harness compatibility, a new VM platform and a full consumer assistant are outside
the initial scope.

## Working style

- Optimize for a working, understandable demo and fast iteration. Prefer the
  smallest complete implementation that proves the intended behavior.
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

- Separate stable agent IDs from temporary run and worker IDs. Persist pending
  work, messages and checkpoints so recovery does not depend on process memory.
- Keep authoritative task state in direct database reads and writes. Use vector
  search for discovery, not task ownership, permissions or current version checks.
- Claim work atomically using leases. Reject commits from superseded attempts.
  Serialize turns that advance the same agent's conversation checkpoint.
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
- Store large artifacts in versioned file/object storage with references and
  hashes in Atlas. Avoid unbounded arrays in a single document.
- Isolate concurrent file edits with separate branches or workspaces; integrate
  results through an explicit verification step.
- Put limits on concurrency, retries, peer-message hops, runtime and model spend.
  Make failures explicit rather than retrying indefinitely.

## Engineering and validation

- Use explicit schemas and validate external inputs and agent tool arguments.
  Return actionable errors; do not swallow exceptions or silently report success.
- Keep credentials in the control plane and out of guest workspaces, source
  control, prompts and logs. Provide configuration through environment variables
  and a documented example file containing placeholders.
- Record structured events with agent, task, run and causal references. Capture
  actual messages, tool results, artifacts and verification outcomes; UI animations
  must reflect recorded activity.
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

1. Complete one real task through peer collaboration and verify the outcome.
2. Destroy workers, restore the same logical agents and reuse prior knowledge.
3. Interrupt a worker and recover unfinished work from a checkpoint.
4. Show the task board, peer messages, evidence and worker changes in the UI.
5. Compare against a simpler baseline when claiming better cost or quality.

Seed a small team and one task domain first. Defer large swarms, autonomous
topology changes, RL training and production hardening until the core loop works.
When finishing a task, summarize what changed, how it was checked and what remains
incomplete.
