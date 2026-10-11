# Shared state and messaging contract

This contract defines the first coordination-service slice. Atlas owns durable
records and authorization decisions. Agents request changes through authenticated
HTTP APIs; they do not write the database directly. The runtime now consumes the
outbox and sequences Pi invocations using Temporal and Modal; see [runtime setup](runtime.md).

## Identity and authority

Each run has an immutable objective, repository and worker limit. Agent IDs are
stable and globally unique; each agent belongs to exactly one run. The operator
registers logical agents through bootstrap APIs. Registration does not provision a
sandbox, start a workflow or prove an agent is running. Roles are descriptive; a
worker can contact any peer regardless of role. A run can have one orchestrator,
which does not consume worker capacity.

Operator calls require `ADMIN_TOKEN`. Agent calls require a random bearer token
scoped to one registered agent and run. Only its SHA-256 hash is stored, and hashes
are omitted from API responses. The server derives the sender/actor from the token.
Bootstrap registration is immutable and retryable with the same ID and content;
credential rotation and lifecycle changes are later work. Use TLS when exposing
these APIs beyond localhost. Sandboxes must never receive the operator token.

## Task transitions

| Operation | Preconditions | Result |
| --- | --- | --- |
| Create | Any run member; dependencies already exist in the run | Open task, no owner, version 1 |
| Claim | Open and unowned; all dependencies done | Claimant owns task; in progress |
| Block | Owner; in progress; reason provided | Blocked, owner retained |
| Resume | Owner; blocked | In progress |
| Submit | Owner; in progress; commit, verification notes and another agent as reviewer | In review |
| Request changes | Assigned reviewer; in review; reason provided | In progress with same owner; obsolete result cleared |
| Approve | Assigned reviewer; in review; verification references submitted commit | Done |

Dependencies and task definitions are immutable in this slice. Requiring existing
dependencies on creation prevents cycles. Done is terminal, making dependency
checks stable; reopening completed work requires a future explicit design.
Task ownership survives a disconnect. Reassignment is not exposed yet.

A claim uses a conditional update inside a transaction. Exactly one competing
claimant wins; a repeated claim by the current owner while in progress returns the
same task. Other conflicts return 409. Updates require `expectedVersion`; a stale
or repeated update returns 409 rather than silently overwriting newer work. Read
the latest task before choosing the next update. Task changes and audit events
commit together. Audit events retain submitted commit references, verification
notes and rejection reasons even when the current task result is cleared.

Result commits must be full 40-character SHA-1 commit IDs. Verification text is a
reported claim, not trusted execution evidence. This service does not fetch Git,
check that a commit is pushed, or run tests. Pi can run Git and tests inside each guest, but a trusted evaluator is still
future work. Self-review is disallowed, including for orchestrators.

## Channels, messages and actionable deliveries

Every run has one team channel. All agents in that run, including agents registered
later, can read its history. A DM is a stable channel for an unordered pair of
agents in the same run; only those two agents can discover, read or write it.

Messages are immutable. They contain a sender, channel, body, optional reply ID,
explicit mentions and a server-assigned sequence within that channel. Replies must
reference a message in the same channel. Pagination reads `sequence > after`, in
ascending order, so agents can persist their last-read position.

- Team posts without mentions create history but no actionable delivery.
- Team posts with mentions create deliveries only for those members.
- DMs create a delivery for the other participant.
- Sending does not wake the sender. Replying does not implicitly notify anyone
  beyond the DM recipient or explicit mentions.

Sending a message writes the message, one delivery per recipient, one wakeup
outbox record per delivery and an audit event in a single Atlas transaction.
Nothing is acknowledged if any write fails. Recipients read pending delivery IDs
through their inbox, including channel ID and sequence so the exact message can
be fetched with `after=sequence-1&limit=1`. The inbox is
read-only in this slice: reading does not mean processing or acknowledgement.

Task creation and message sending require a `requestId`, unique per run, sender
and operation type. Identical retries return the existing record; different
content with the same ID returns 409. Mention/dependency ordering is normalized.
Task-create retries return current task state. Message retries return the original
message. A message request ID is scoped across all channels, so accidentally
retrying it in another channel fails instead of sending twice.

## Durable execution boundary

The implemented outbox contains pending `mailbox_wakeup` notifications with a
recipient and delivery ID. The runtime relays these to
`agent/<agentId>` Temporal workflows. A sent notification will not acknowledge a
delivery. Failed relay attempts must remain retryable, and periodic reconciliation
must find pending inbox work even after lost notifications.

Implemented delivery transitions are `pending -> processing -> completed`, with a
lease and invocation generation on processing. Only checkpoint publication can
complete a delivery. A failed invocation with ambiguous external effects needs
inspection instead of automatic command replay. This slice deliberately exposes
no acknowledgement endpoint that could bypass that checkpoint requirement.

Atlas transactions cannot atomically signal Temporal or push Git. The runtime
uses a durable outbox and reconciler across Atlas and Temporal. Activity retries
do not promise exactly-once shell or Git effects; uncertain execution requires
inspection. See [runtime verification](runtime.md#verification-and-limits).

## HTTP surface

All paths below use JSON. Agent routes are scoped under `/runs/:runId`.

| Method and path | Purpose |
| --- | --- |
| `PUT /admin/runs/:runId` | Bootstrap run and team channel |
| `PUT /admin/runs/:runId/agents/:agentId` | Register logical agent and reserve capacity |
| `GET /runs/:runId/agents` | List peers without credentials |
| `POST /runs/:runId/tasks` | Create a task with request ID |
| `GET /runs/:runId/tasks` | Read task state |
| `POST /runs/:runId/tasks/:taskId/claim` | Claim work atomically |
| `PATCH /runs/:runId/tasks/:taskId` | Apply versioned transition |
| `GET /runs/:runId/channels` | List accessible channels |
| `POST /runs/:runId/channels/dm` | Find or create a DM using `peerId` |
| `POST /runs/:runId/channels/:channelId/messages` | Persist message and deliveries |
| `GET /runs/:runId/channels/:channelId/messages` | Read ordered history |
| `GET /runs/:runId/inbox` | Read the caller's pending deliveries |

List APIs default to 50 and cap at 100 records. Agent, task, channel and inbox lists
use an ID `after` cursor and return `nextCursor`; they are paginated snapshots, not
live streams. Restart inbox scans from the beginning during reconciliation, since
new IDs need not sort after the previous cursor. Message history uses a numeric
`after` sequence and returns `nextAfter`.

All writes validate bounded schemas and reject unknown fields. Invalid input is
400, invalid credentials 401, unauthorized transitions 403, inaccessible resources
404, and competing claims/version/idempotency conflicts 409. Server failures return
a generic 500 without credentials or database details.

## Verification and limits

Tests use an actual temporary MongoDB replica set to exercise concurrent claims,
review permissions, cross-run isolation, duplicate sends, capacity limits,
transaction rollback and a new backend connection recovering pending messages.
These establish local database behavior, not an Atlas cloud integration.

The HTTP demo uses synthetic identities and evidence. The runtime implements
Temporal relay, invocation leases, checkpoint publication, Modal provisioning,
Pi execution and agent lifecycle updates. It acknowledges inbox work only with a
durable checkpoint. Task reassignment, the planning orchestrator's tools and
automated sandbox replacement remain future work. Live Atlas integration is
still unverified.
