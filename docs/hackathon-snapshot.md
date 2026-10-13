# Hackathon snapshot: Atlas-backed persistent agent swarms

Recorded on 2026-10-13 after the hackathon ended.

## Version record

- Snapshot branch: `codex/snapshot-hackathon-atlas-swarms-2026-10-13`.
- Source: updated `main`, matching `origin/main` when this snapshot was created.
- Source commit: `a25ae7101d8c982a71040226406c02d8b205df56` —
  “Launch durable agent teams from live conversations”.
- The snapshot adds this record and a README link. All application code,
  dependencies, configuration, tests and existing design documents match the
  source commit. The source SHA identifies the exact version before those additions.
- Uncommitted work in the original checkout is outside this snapshot and remains
  in that checkout.

Keep this branch as the historical reference for the hackathon version. Future
experiments should develop separately rather than updating this snapshot.

## What this version contains

The hackathon explored persistent agent teams with a trusted coordination backend
and one cloud sandbox per agent. The recorded architecture uses:

- TypeScript, Node.js and Fastify for the backend and operator API.
- MongoDB Atlas for agent identities, tasks, messages, deliveries, checkpoints
  and events.
- Temporal for durable scheduling, wakeups, deadlines and cleanup.
- Modal sandboxes running the Pi agent SDK, with private workspaces and optional
  Git repositories.
- A planning orchestrator that can request workers within configured limits,
  plus team chat, peer DMs, tasks and optional review evidence.
- A React/Vite/Tailwind dashboard and CLI, with offline fixtures available.

The existing [README](../README.md) retains setup and demo commands.
[Runtime notes](runtime.md) and [orchestration notes](orchestration.md) describe
implemented behavior and recorded validation. [Milestone 1](milestone-1.md)
records the original acceptance criteria; it is not a claim that every criterion
was achieved.

## Limits retained with the snapshot

Agent continuity is scoped to an active run. Completed runs retain records and
checkpoints and stop compute; reusing the same team across completed runs is
deferred. Idle Modal sandboxes remain alive and billed. Sandbox replacement can
restore confirmed native Pi checkpoints and pushed Git revisions; uncommitted
files, running processes and ambiguous external effects have separate recovery
limits. Agent evidence is not automatically a trusted evaluation result.

Existing documents distinguish scripted fixtures from real integration evidence.
Creating this snapshot does not revalidate Atlas, Modal, Temporal or model access,
and does not capture database contents, sandbox state or credentials.

## Transition to broader experiments

The hackathon is over. The next phase will use atoi as a broader experimental
project. Atlas and the other hackathon infrastructure choices are historical
implementation decisions, not fixed requirements for that phase.

This step preserves the current version and records that change in direction.
It does not select a replacement architecture or remove integrations. The next
scope and implementation changes await the project owner's instructions. The
hackathon-specific guidance in this branch's `AGENTS.md` remains part of the
historical record; revisit active project guidance when the next phase starts.

To compare future work with the exact original code, use the source commit above.
To inspect the documented archive, check out the snapshot branch in a separate
worktree. Retain this version's lockfile and environment examples when reproducing
it; live services and credentials still need to be supplied separately.
