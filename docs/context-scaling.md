# Filesystem context, persistent VMs and context scaling

These mechanisms are part of atoi's project idea: retain useful context in agent
sessions and executable workspaces, and connect those agents through messages and
versioned evidence. They support the [personal cloud-team story](product-story.md).
The intended benefits are better continuity, more context available to the team,
and less dependence on lossy handoffs. They are hypotheses to evaluate.

## Where context lives

| Layer                      | Contents                                                                 | How it is used                                                                                            |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Agent session              | Conversation, tool results and compaction entries                        | The same agent continues reasoning from a confirmed native Pi checkpoint.                                 |
| Private sandbox filesystem | Notes, source data, code, test cases, scripts and installed dependencies | The agent reads relevant material and reruns experiments instead of fitting every detail into its prompt. |
| Shared Git artifacts       | Published files at immutable commits                                     | Peers fetch and inspect the same version in their own private clones.                                     |
| Shared coordination state  | Tasks, ownership, messages, deliveries, events and artifact references   | The team knows who is working on what and where to find the recorded result.                              |

Externalizing context means writing explicit information and work products outside
the model's active window. It does not export hidden model state. Files are useful
only when agents can find, read and interpret them; a pointer alone does not give
a model the contents of a file.

Individual sessions and private files remain distinct from shared task state.
Shared state helps coordinate work and locate evidence. It does not need to contain
every agent's full context, or turn every generated assertion into a shared fact.

## Why each agent gets a persistent execution environment

An agent may need its code, dependencies, test inputs and tools to investigate a
follow-up. Retaining the sandbox within a run keeps that working environment
available. It can inspect an earlier experiment, modify one condition and execute
it again. The original agent's session supplies context about the decisions behind
the work.

Each agent owns a private environment and clone. Collaboration uses backend
messages and pushed Git artifacts; peers do not access one another's sandbox or
share one mutable filesystem. This lets them work independently and review an
exact advertised revision.

Persistent agent identity, session continuity and sandbox lifetime are separate.
The Pi process can end between turns while the sandbox remains alive. The next
invocation restores its native session from Atlas and uses the retained files.
See [runtime behavior and recovery limits](runtime.md).

## Reducing dependence on compressed messages

A summary selects what seems important at the time it is written. A later question
may need a detail that was omitted. atoi's design provides two ways to revisit it:

- Inspect the source artifact at the recorded repository, commit and path.
- Ask the agent that investigated it a new, specific question. That agent can
  consult its session and files, verify the new condition, and respond.

For example, an agent could publish test inputs, an experiment script and notes
about a rejected approach. Its handoff identifies the pushed commit and relevant
paths. When a peer encounters a new edge case, it can fetch those inputs and ask
the author to rerun the experiment with that condition.

Direct peer communication also avoids requiring the planner to re-summarize every
exchange. The planner can coordinate the goal while the detailed conversation
happens between the members doing the work.

This can reduce the number of details that must survive one summary or a chain of
relays. It does not eliminate communication loss: an answer can be wrong, a file
can be irrelevant, or the agent may not know which artifact to look for. References
need versions and evidence, and recipients still need to check applicability.

## What context scaling means here

Several retained sessions provide several focused working contexts. Their files
provide additional material that can be loaded selectively. Messages connect
those contexts so a question can be answered where the relevant work already
exists. Independent experiments can also run in parallel.

The goal is to handle a larger or longer task without requiring one agent to keep
all of its details in a single prompt. This organizes inference compute across
agents, storage and tools. It does not expand a model's native attention window
or make N agents equivalent to one model with N times the context capacity.
Each agent can still compact, retrieval takes work, and communication has a cost.
The benefit depends on whether the task can be split across useful boundaries.

## Current foundation and proof needed

The runtime notes record native Pi session restoration and a successful follow-up
read of a private file in a real Modal/Atlas/model run. This establishes a small
continuity check. It does not establish reduced communication loss, cheaper
execution or large-swarm context scaling.

Filesystem externalization is available through Pi's file and shell tools. The
system does not automatically identify every detail worth saving or discover all
relevant peer expertise. Semantic discovery remains deferred.

Files and dependencies survive while the sandbox lives. The replacement recovery
contract covers confirmed Pi checkpoints and pushed Git revisions; uncommitted
files, running processes and RAM are outside that guarantee. Automated replacement
is still pending. Continuity currently ends with the run; keeping the same team
across completed runs is future work.

To test this design, compare summary-only handoffs, handoffs with versioned file
references, and retained agents with file references. Keep the model, task sequence,
artifact access and verification criteria comparable. Introduce later questions
whose required details were not obvious at the first handoff. Measure correct
answers, omitted facts, repeated reads and experiments, tokens, elapsed time and
total execution cost. Increase agents and task complexity separately, and report
where coordination overhead outweighs the benefit.

## Deferred context sharing

Native Pi session checkpoints remain private to their agent and are restored by the
trusted backend. Peer discovery currently uses agent listings, tasks, conversations
and Git references; there is no cross-agent session reader or semantic memory search.

Future work may let agents publish scoped working memories with source evidence,
verification status and freshness, then retrieve those records and consult the original
agent. This would require explicit access rules and evaluation of retrieval quality and
token cost. Atlas Search/Vector Search and Change Streams are not implemented in this
slice. VM IDs can remain available in diagnostics while the main UI emphasizes work,
artifacts and continuity.
