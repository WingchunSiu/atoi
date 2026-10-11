# atoi

A persistent swarm harness for work that takes hours, days or weeks. Each agent
keeps its own workspace, memory and goals, sleeps between tasks, and wakes when
a peer or a scheduled task needs it.

Pi runs inside one Modal sandbox per agent. Temporal coordinates durable work
through per-agent workflows and a trusted TypeScript worker. MongoDB Atlas stores
agent records, tasks, messages and Pi session checkpoints. Git holds shared project
files and artifacts. A lost sandbox can be replaced from checkpointed context and
pushed commits, with recovery limits made explicit.

For example, a developer agent improves a failing application while a reviewer
checks its changes and a specialist investigates earlier failures. Their
workflows wait between invocations. A new test result wakes the relevant agent,
which continues from its checkpoint toward a verified goal. Sandbox suspension
and environment retention must be verified against Modal’s actual capabilities.

## Status

This repository currently contains project guidance and the first milestone design.
The runtime and cloud integrations are not implemented or tested yet. There are
no application setup or run commands. Add reproducible setup and demo instructions
with the first working implementation.

The first milestone includes an orchestrator that spawns a configurable worker
team. The initial test uses two workers, an implementer and reviewer, plus the
orchestrator. It will validate Git handoffs, durable messaging, Temporal wakeups and worker
restart, and checkpoint recovery after sandbox replacement. A third-worker smoke
check will verify that membership and routing are not hard-coded to the fixture.

## Design and contributing

- [Current milestone and acceptance checks](docs/milestone-1.md)
- [Agent engineering and PR rules](AGENTS.md)
