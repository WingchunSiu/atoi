# Your persistent AI team in the cloud

This document describes atoi's product vision and the capabilities we intend to
prove. It is a positioning narrative, not a claim that the entire product has
shipped. [Milestone 1](milestone-1.md) defines acceptance; [runtime notes](runtime.md)
record implementation, checks and remaining integration work.

## The pitch

Complex work grows beyond a single conversation. atoi gives you a persistent AI
team in the cloud: agents with their own workspaces, retained session context and
direct access to one another. Each member can investigate, create, test and leave
evidence. When the next question arrives, you can return to the agent that did the
work and continue the conversation. You set the direction in a shared team chat;
the team keeps tasks, findings and handoffs connected as the project develops.

**Give your goals a team that stays available to keep working with you.**

## The story

You have a research idea you want to turn into a small product. You need to
understand the problem, build a prototype and find out whether it works.

You open the team chat and describe the goal. One member investigates the domain,
another works on the prototype, and another tests the result. These are starting
responsibilities; any member can ask a peer for help or create a follow-up task.

Each agent has somewhere to work. Its sandbox contains its files, dependencies,
experiments and tools. Its session carries the context of what it has investigated.
The shared task board records ownership, progress and artifact references. The
conversation shows questions, decisions and evidence.

Partway through the prototype, the implementer encounters an assumption that the
researcher examined earlier. It messages that researcher directly:

> Does your earlier result still hold under this new condition? Can you check the
> approach you ruled out?

The researcher continues from its prior session, checks the new condition and
runs another experiment. It can give a different answer to a different question,
with the relevant evidence attached. The implementer proceeds, and the reviewer
checks the exact version of the result.

You can enter the group chat, message one member, change the direction or inspect
what happened. As your goal develops, the same members remain available for more
work. Their context stays with them; their results remain available to the team.

That is the personal-agent vision: a team you can keep working with around an
ongoing goal. Coding is our first test case. Research, writing and other personal
projects are possible extensions that need their own tools and acceptance checks.

## Why persistent agents matter for inference scaling

Inference scaling spends more compute at task time on reasoning, tools, search
and verification. Long tasks also build more context than one model invocation
can hold. The design question is how to organize that compute and keep useful
context available over the course of the work.

[On the Nature of the Swarm](https://hallerite.com/posts/on-the-nature-of-the-swarm/)
argues that compaction must anticipate which information will matter later.
Files preserve information but require someone to find and interpret it again.
A disposable sub-agent supplies a targeted answer, while a retained agent can
answer later questions from its existing context. The article proposes persistence
and direct peer communication as ways to keep several contexts useful together.
This is a design thesis, not a universal scaling guarantee.

atoi's capabilities follow from that thesis:

| Capability                 | What it enables                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Retained agent sessions    | Ask new questions of the same agent after its initial task; restore confirmed context between turns.             |
| Separate cloud workspaces  | Run investigations, code and tests independently, with files and tools available in each living sandbox.         |
| Direct peer messages       | Let the member with the question consult the relevant peer without relaying every exchange through the planner.  |
| Shared authoritative state | Coordinate ownership, dependencies, handoffs and versioned evidence while keeping each agent's session distinct. |
| Durable scheduling         | Wait between turns and resume on messages or timers without keeping a model invocation open.                     |

Independent work can use compute in parallel. Retained sessions also keep multiple
focused contexts available for later collaboration, even when agents take turns
executing. A question can be answered where the relevant context resides, and the
requester receives the information needed for its next step.

This does not create one model with an unlimited context window. Each agent still
has context limits and may compact its session. Communication consumes tokens and
can omit details. Tasks that require all information in one place may benefit
little from this structure. Persistence does not change model weights or establish
that the team learns automatically; new assertions still need evidence and review.

The planning orchestrator helps organize the goal, seed work and assess outcomes.
It is not the required route for ordinary peer conversations. The trusted backend
still enforces authority, budgets and lifecycle rules independently of the agents.

## Scale and cost: what we intend to demonstrate

We aim to increase the amount of project context that a team can keep available
and use across a long task. More agents provide more places to investigate and
retain context, with communication and coordination overhead. Worker admission
limits bound active and pending capacity. Large-swarm throughput, useful context
capacity and cost scaling require measurement; none follows from agent count alone.

Persistence may reduce repeated investigation, environment setup and rebuilding
context. Follow-up messages and longer retained sessions also cost tokens. Keeping
living sandboxes available costs compute; waiting for a message does not imply a
free VM. Modal bills sandbox CPU and memory by the second using the higher of
requested and actual resources. See [sandbox pricing](https://modal.com/docs/guide/sandbox-resources).

The economic hypothesis is that avoided work can outweigh retention and
coordination costs on related, recurring tasks. Evaluate total model usage,
compaction and peer messages, sandbox time, storage and control-plane costs.
Record human intervention and verification quality as well as elapsed time.
Faster parallel execution and cheaper execution are separate results to measure.

## The demo that proves the story

Use a bounded coding task with a later follow-up whose answer was not fully
specified in the original handoff:

1. An agent investigates an issue, produces a pushed artifact and records evidence.
2. It checkpoints and waits after its initial work finishes.
3. A peer encounters a related question and messages that same agent directly.
4. The recipient continues from its prior session, checks the new condition and
   returns evidence. Show the prior context, new tool activity and resulting handoff.
5. Verify the final artifact independently at the advertised commit.
6. In focused recovery checks, restart the Temporal worker and replace a sandbox.
   Show restored checkpointed context and pending deliveries, with any ambiguous
   effects visible for inspection.

Compare a retained team with disposable workers using the same model, task
sequence, budgets, artifact access and verification criteria. Count repeated reads
and experiments, total tokens, compute cost, elapsed time and human interventions.
Check whether gains come from persistence rather than merely more compute or
better access to saved artifacts. Report the observed results, including cases
where retention is more expensive or communication fails.

## Product vision and current boundaries

The long-term product is a personal cloud team that remains available across
projects and sessions. The first milestone retains agents across turns and tasks
within one run. Completing an objective keeps the team available. Stop or the
team deadline ends compute; reopening stopped teams is deferred. Consult the runtime notes for the current implementation and verification
status rather than treating milestone acceptance criteria as completed checks.

An agent's durable identity is distinct from its sandbox. Files and dependencies
remain available while that sandbox lives. Replacement recovery is based on
confirmed native Pi checkpoints and pushed Git revisions; uncommitted files,
running processes and RAM have no replacement guarantee. Idle suspension and
snapshot behavior must be verified before promising them.

Broader personal-agent work needs browser/app integrations, scoped account access,
operator controls for consequential actions and cross-run team continuity. These
are product extensions, not capabilities established by the coding fixture.

## Inspirations

- [On the Nature of the Swarm](https://hallerite.com/posts/on-the-nature-of-the-swarm/):
  motivates retaining agents and locating context across directly connected peers.
- [Raft](https://raft.build/): describes persistent agent identity, memory and
  expertise in a shared human-agent workspace. It is a product reference for team
  chat, tasks and continuity, not evidence that these capabilities are unique to atoi.
- [OpenAI's mathematical research](https://openai.com/index/navier-stokes-solution/):
  reports a coordinating-agent effort with communicating groups and intermediate
  findings informing subsequent work. It motivates exploring inference at larger
  scales; it does not establish atoi's mathematical capability or cost advantage.
