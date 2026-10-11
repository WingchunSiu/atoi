# Agent activity APIs and CLI

The activity layer records Pi messages, tool starts/results, visible text updates,
working notes and invocation lifecycle events. Workers send scoped API requests;
the backend stores events in Atlas and exposes history plus an authenticated SSE
feed. Observers do not own the run lifetime. The browser UI is developed separately
against these APIs; this runtime includes the backend contract and CLI.

## Observe a real run

Start the control plane using [runtime setup](runtime.md). The CLI uses operator
authorization and the persisted activity feed:

```sh
pnpm cli agent <runId> <agentId>
pnpm cli history <runId> [agentId] [afterCursor]
pnpm cli watch <runId> [agentId] [afterCursor]
```

`history` returns a page, `cursor` and `hasMore`. Pass the returned cursor to fetch
the next page. `watch` prints JSON events to stdout and connection status to stderr;
Ctrl-C disconnects observation without stopping the run. Network disconnects retry
with the last consumed cursor; authorization and invalid-input failures stop with
an actionable error.

## API

All read endpoints require the operator bearer token:

| Endpoint | Result |
| --- | --- |
| `GET /operator/runs` | Up to 30 recent runs |
| `GET /operator/runs/:runId/agents/:agentId` | Authoritative agent state, owned tasks, recent invocations and last activity |
| `GET /operator/runs/:runId/events` | Ordered event page |
| `GET /operator/runs/:runId/events/stream` | SSE history replay followed by live activity |

History and stream accept `agentId`, `after`, `limit` (1–100), and `type` filters.
SSE event IDs are per-run sequence numbers. `Last-Event-ID` and `after` resume
strictly after the higher supplied cursor. Cursors are scoped to a run; a cursor
ahead of that run is rejected. Unknown or out-of-run agent IDs are rejected.

Events receive their sequence and are inserted in one short MongoDB transaction.
The per-run counter serializes publication across concurrent agents. Retrying a
request ID reuses the event; changing its contents produces a conflict. New indexes
are installed by `MongoStore.initialize()`. No database is silently deleted or reset.
Events from older local drafts without sequence numbers are not included in the new
feed; start a new demo run to use ordered history. Existing Pi checkpoints remain
the context recovery source.

Agents can call `write_work_log` with `note`, optional `nextStep`, `taskId` and
`evidence` references. `/runs/:runId/logs` validates the invocation/generation,
deduplicates the note and records `source: agent_reported`. Notes do not complete a
task, verify a claim or change ownership. The tool automatically attaches Pi's
native session ID. Tool arguments, results and notes are treated as untrusted data.

## Limits and validation

- The initial SSE implementation reconciles persisted events every 500 ms. It
  requires no Atlas change stream and recovers after reconnects. This is a small
  demo implementation, not a large-swarm throughput claim. There is a 50-stream
  admission limit, bounded pages and a timeout for slow readers.
- Pi visible-text updates and partial tool results are coalesced over 250 ms.
  Starts, final messages and tool completions flush pending updates. Event uploads
  retry at most three times with the same ID; an unresolved upload failure marks
  the invocation result failed rather than claiming a complete activity record.
- Known runtime credentials are redacted. Oversized outputs retain a bounded
  preview and content hash. Model reasoning chunks are not sent as live text.
- A connected observer does not prove that an agent is healthy. Agent state comes
  from Atlas; consumers can separately track connection state and last event receipt.
- Sandbox loss can still lose text/partial output not yet acknowledged by the
  backend. The feed is observational; it does not provide exactly-once shell
  effects or expand the checkpoint/pushed-Git recovery guarantee.

Focused tests use a real local MongoDB replica set and HTTP/SSE connections to
check concurrent ordering, retries, cursor replay, authorization, stale-generation
rejection, fragmented UTF-8, automatic reconnect, cancellation and server cleanup.
The Pi runtime fixture checks continue to exercise native session recovery.
Integration of the separately developed browser UI is a separate check.
