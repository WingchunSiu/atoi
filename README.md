# atoi

A persistent swarm harness for work that takes hours, days or weeks. Each agent
keeps its own workspace, memory and goals, sleeps between tasks, and wakes when
a peer or a scheduled task needs it.

Pi supplies the agent runtime. Temporal coordinates durable work. MongoDB Atlas
stores agent records, messages, memory, evidence and checkpoint references.
Each agent has a private sandbox that pauses and resumes across tasks; E2B is
the initial provider candidate. A lost sandbox can be replaced from declared
recovery state.

For example, a developer agent improves a failing application while a reviewer
checks its changes and a specialist investigates earlier failures. All three
pause overnight. A new test result wakes the relevant agent, which resumes its
files, remembers previous experiments and continues toward a verified goal.

## Status

This repository currently contains project guidance and an architecture proposal.
The runtime and cloud integrations are not implemented or tested yet. There are
no application setup or run commands. Add reproducible setup and demo instructions
with the first working implementation.

The first milestone is three agents completing one measurable task, exchanging
durable messages, pausing and resuming, and recovering from a runner crash.
Billions of tokens is a future cumulative-history target; demonstrating useful
recall and measured progress comes first.

## Design and contributing

- [Architecture and acceptance checks](docs/architecture.md)
- [Agent engineering and PR rules](AGENTS.md)
