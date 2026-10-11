# Your persistent AI team in the cloud

atoi's product vision is a personal cloud team whose members remain available as
your goals develop. Coding is the first test case. [Milestone 1](milestone-1.md)
defines the initial scope; the [README](../README.md#implemented) records what has
landed.

## The story

You have a research idea you want to turn into a small product. One agent
investigates the problem, another builds a prototype, and another verifies the
result. Each has its own workspace, tools and session context. Their tasks,
conversations and evidence live in a shared team workspace.

The implementer encounters a new condition that affects the researcher's earlier
finding. It messages that researcher directly:

> Does your earlier result still hold here? Can you check the approach you ruled out?

The researcher continues from its prior session, checks the new condition and
runs another experiment. The implementer proceeds; the reviewer checks the exact
version of the result. You can enter the group chat, message a member or change
the direction.

Completing the first task leaves each agent available for the next question.
The team can continue investigating, creating and verifying as your goal develops.

> atoi is your persistent AI team in the cloud. Each agent has its own workspace,
> stays available for follow-ups, and collaborates with the others as your goals develop.

## Inference scaling through persistent contexts

Inference scaling spends more compute at task time on reasoning, tools, search
and verification. Long tasks also build more context than one model invocation
can hold. We need to organize that compute and keep relevant context accessible.

[On the Nature of the Swarm](https://hallerite.com/posts/on-the-nature-of-the-swarm/)
argues that compaction must anticipate what will matter later. Saved files need
to be found and interpreted again. A retained agent can answer new questions from
its existing context, once the question is known. It proposes persistence and
direct peer communication to keep several contexts useful together.

atoi follows that thesis with five capabilities:

- **Retained sessions:** return to the same agent for follow-up work.
- **Separate cloud workspaces:** investigate, build and test independently.
- **Direct peer messages:** ask where the relevant context resides, without
  routing every exchange through the planner.
- **Shared authoritative state:** coordinate ownership, handoffs and versioned evidence.
- **Durable scheduling:** wait between turns and resume on messages or timers
  without holding a model invocation open.

Independent work can run in parallel. Several focused contexts also remain
available for later collaboration, even when agents take turns executing.
The goal is to support longer, more complex work through a team whose contexts
stay accessible throughout the project.

Each agent still has context limits and may compact. Communication costs tokens
and can lose detail. Multiple agents do not create one unlimited context window,
and tasks that need all information in one place may benefit little. This is a
scaling hypothesis to test, not a guarantee of linear gains.

## Cost and proof

Persistence may reduce repeated investigation, environment setup and context
rebuilding. It also adds retention and communication costs. Living Modal
sandboxes remain billable; their CPU and memory charges use the higher of
requested and actual resources. See [Modal's pricing explanation](https://modal.com/docs/guide/sandbox-resources).

The demo should show an agent finishing a task, checkpointing and waiting, then
answering a peer's new question from its earlier session. Record the new tool
activity and verify the resulting artifact. Focused recovery checks should show
checkpoint restoration and pending delivery after worker restart or sandbox
replacement, with ambiguous effects exposed for inspection.

Compare a retained team with disposable workers using the same model, tasks,
budgets, artifact access and verification criteria. Measure total tokens, repeated
reads and experiments, sandbox time, elapsed time, human intervention and result
quality. Claim savings or improved scaling only when those results support them.

## Product boundaries

The first milestone retains agents across turns and tasks within one run.
Completing a run stops compute. Reusing the same team across completed runs is
part of the longer-term personal-team vision.

Durable agent identity is separate from the sandbox. Replacement recovery targets
confirmed native Pi checkpoints and pushed Git revisions. Uncommitted files,
running processes and RAM have no replacement guarantee. Suspension and snapshot
behavior require verification.

Personal projects beyond code need browser/app integrations, scoped account
access and operator controls for consequential actions. Those extensions are
outside the initial coding fixture.

## Inspirations

- [On the Nature of the Swarm](https://hallerite.com/posts/on-the-nature-of-the-swarm/):
  retained agent contexts and direct peer collaboration.
- [Raft](https://raft.build/): persistent identity, memory and expertise in a shared
  human-agent workspace. A product reference, not a claim of uniqueness.
- [OpenAI's mathematical research](https://openai.com/index/navier-stokes-solution/):
  a reported coordinating-agent effort using communicating groups and intermediate
  findings. An inference-scaling reference, not evidence of atoi's performance.
