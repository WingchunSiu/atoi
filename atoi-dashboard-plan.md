# atoi dashboard design plan

This plan is for the coding agent building the atoi dashboard. It is self-contained, so read it top to bottom before writing code. A hand-drawn reference sketch of the mesh (`mesh-sketch.png`) should accompany this file, and the visual language below is taken from it.

The dashboard is being built now, in parallel with the backend. Build it against labeled mock data first, behind a data contract the backend will implement, then switch to the live backend when it exists.

## At a glance

- One screen with a top bar, a mesh canvas in the center, an inspector on the right, and an event timeline along the bottom.
- The canvas shows a "shared state" hub (git, tasks and chat) with agent cards on a ring around it. A peer line appears between two agents only after they actually DM each other.
- Every visual change comes from a recorded backend event. The UI state is a pure fold over an ordered event log, which also gives you replay and scrubbing for free.
- Data arrives over one server-sent events (SSE) stream per run. Until the backend exists, the same events come from fixture files, and the UI says so on screen.
- Stack is React, Vite, TypeScript, Tailwind v4 and React Flow, plus Vitest for tests.

## 1. What you are visualizing

atoi runs a persistent team of AI coding agents. A run starts from a CLI with an objective, a Git repository and a worker limit. An orchestrator agent spawns workers (in the first demo, an implementer and a reviewer), creates tasks and decides when the run is complete. Each agent is a Pi coding agent running in its own Modal cloud sandbox with a private Git clone. Agents talk through one team channel and through direct messages (DMs), claim tasks from a shared task list, and hand work to each other as pushed Git commits.

Between pieces of work an agent sleeps. Its Temporal workflow waits for a DM, an @mention or a timer, and its conversation is checkpointed to MongoDB Atlas. If a sandbox is lost, a new sandbox restores the latest checkpoint and fetches the last pushed commit. A Fastify backend owns all of this state, and the dashboard only reads it.

The demo tells two stories, and the dashboard must make both legible to someone watching for three minutes.

1. Collaboration. The orchestrator spawns workers, the implementer claims a task, pushes a commit and DMs the reviewer, the reviewer tests that exact commit and sends feedback, a fixed commit is approved, and the orchestrator completes the run.
2. Durability. The reviewer sleeps, wakes on a DM, wakes on a timer, keeps its place through a scheduler restart, and survives a sandbox replacement while a message waits in its inbox.

### Glossary

| Term | Meaning |
| --- | --- |
| Run | One team working toward one objective. Has a status and a worker limit. |
| Agent | A durable team member with a stable ID, role and memory. Outlives any single sandbox. |
| Orchestrator | The agent that spawns workers and completes the run. Otherwise a normal peer. |
| Worker | Any agent the orchestrator spawned. Roles (implementer, reviewer, ...) are free-form strings. |
| Sandbox | The Modal container an agent currently runs in. Can be suspended, terminated or replaced. |
| Invocation | One bounded turn of an agent's Pi loop. Never more than one at a time per agent. |
| Generation | Counter that increases each time an agent moves to a replacement sandbox. |
| Delivery | A message waiting in a specific agent's inbox. DMs and @mentions create deliveries. |
| Checkpoint | A saved, versioned copy of the agent's conversation, used to restore after replacement. |
| Verification | A recorded test or check result against a specific commit. |
| Temporal worker | The scheduler process that wakes agents. It can restart without losing pending work. |

## 2. Ground rules

1. Every visual state derives from a recorded event. Do not animate activity the event log doesn't contain, and do not infer states the backend didn't report.
2. Mock and replayed data is always labeled on screen (section 10).
3. The browser talks only to the backend's HTTP API. It never holds database or cloud credentials.
4. Nothing about roles is hard-coded. Two workers, three workers and arbitrary role names must all render without code changes.
5. Missing data hides its UI element. If the backend never sends sandbox events, the sandbox strip simply doesn't render.
6. Never fail silently. Malformed events are skipped, logged to the console and counted in the timeline header.
7. Design for a projector first. That means 1280×720 and 1920×1080, large type, strong lines and high contrast.

## 3. Stack and project layout

- React 19, Vite, TypeScript (strict), Tailwind v4 with tokens declared in `@theme`.
- `@xyflow/react` (React Flow) for the canvas, using custom node and edge types.
- `zod` to validate incoming events, since a contract shared between two teams drifts.
- `@fontsource/ibm-plex-mono` and `@fontsource/ibm-plex-sans`, self-hosted.
- Vitest for unit tests and `tsx` for scripts. Playwright is optional, for screenshots.
- No state library is needed. Use a pure reducer with a small store built on `useSyncExternalStore`.

Put the app in `dashboard/` at the repo root unless the repo already uses a workspace layout such as `apps/`, in which case follow it. Use the repo's package manager if one is already chosen, otherwise npm.

```
dashboard/
  index.html
  vite.config.ts                 # proxies /api to VITE_API_TARGET
  public/fixtures/*.ndjson       # generated by `npm run fixtures`
  public/recordings/*.ndjson     # recorded real runs for replay
  scripts/
    build-fixtures.ts            # writes public/fixtures from fixtures/*.ts
    fake-sse.ts                  # local mock backend that streams a fixture over SSE
    record.ts                    # saves a live run's events to NDJSON
  fixtures/
    builder.ts
    happy-path.ts
    recovery.ts
    third-worker.ts
    edge-states.ts
  src/
    contract/events.ts           # event types + zod schemas, dependency-free except zod
    sources/                     # live, replay and mock sources
    state/reduce.ts              # pure fold
    state/selectors.ts
    state/playback.ts            # cursor, speed, follow-live
    state/store.ts
    canvas/geometry.ts           # slot positions + edge paths, shared by edges and animations
    canvas/                      # HubNode, AgentNode, SlotNode, SpokeEdge, PeerEdge, SpawnEdge, ActivityLayer
    inspector/                   # Summary, Tasks, Chat, Git, AgentDetail, ThreadDetail
    timeline/                    # Scrubber, EventFeed
    topbar/
    styles/tokens.css
  tests/
```

Keep `src/contract/events.ts` free of React and app imports so the backend team can import or copy it.

## 4. Data contract

### 4.1 Events

Every event shares an envelope. `seq` increases strictly within a run and is the only ordering key. `agentId` names the agent the event is about.

```ts
// src/contract/events.ts
export type AgentId = string;

export type RunStatus = "starting" | "running" | "completing" | "completed" | "failed" | "cancelled";
export type AgentState =
  | "provisioning" | "waiting" | "running" | "checkpointing"
  | "recovering" | "needs_inspection" | "stopped" | "failed";
export type SandboxState = "starting" | "running" | "suspended" | "terminated";
export type TaskStatus = "open" | "in_progress" | "blocked" | "in_review" | "done";
export type WakeReason = "dm" | "mention" | "timer";

export interface Task {
  id: string;
  title: string;
  description?: string;
  acceptance?: string[];
  status: TaskStatus;
  ownerId?: AgentId;
  dependsOn?: string[];
  resultCommit?: string;
}

interface Envelope {
  seq: number;          // strictly increasing per run; SSE `id`
  ts: string;           // ISO 8601
  runId: string;
  agentId?: AgentId;    // the agent this event is about
  taskId?: string;
  causedBy?: string;    // id of the message, timer or invocation that caused it
}

export type RunEvent = Envelope & (
  | { type: "run.state"; status: RunStatus; objective?: string; repo?: string;
      workerLimit?: number; finalCommit?: string; outcome?: string }
  | { type: "agent.spawned"; role: string; kind: "orchestrator" | "worker"; spawnedBy?: AgentId }
  | { type: "agent.state"; state: AgentState; generation: number;
      invocationId?: string; wakeAt?: string; detail?: string }
  | { type: "sandbox.state"; state: SandboxState; sandboxId: string }
  | { type: "agent.woken"; reason: WakeReason }
  | { type: "checkpoint"; action: "saved" | "restored"; version: number }
  | { type: "message.sent"; messageId: string; channelId: string; channelKind: "team" | "dm";
      from: AgentId; to: AgentId[]; body: string; replyTo?: string }
      // `to` lists addressed agents: the DM peer, or @mentioned agents in the team channel.
      // A plain team message has `to: []`.
  | { type: "delivery.queued"; deliveryId: string; messageId: string }   // agentId = recipient
  | { type: "delivery.done"; deliveryId: string; messageId: string }     // agentId = recipient
  | { type: "task.upserted"; task: Task }                                // always the full task
  | { type: "tool.called"; tool: string; summary: string; invocationId?: string }
  | { type: "git.pushed"; branch: string; commit: string; message?: string }
  | { type: "verification.recorded"; commit: string; command: string; passed: boolean; summary?: string }
  | { type: "usage"; invocationId?: string; model?: string; inputTokens: number;
      outputTokens: number; costUsd: number; durationMs: number }
  | { type: "worker.restarted" }
  | { type: "failure.recorded"; failureId: string;
      scope: "provisioning" | "invocation" | "relay" | "recovery" | "cleanup";
      message: string; resolved: boolean }                              // upsert by failureId
);
```

Write matching zod schemas in the same file. Validate the envelope strictly. If the `type` is unknown, keep the event in the feed as "unknown" and ignore it in the reducer, so a newer backend doesn't break an older dashboard.

### 4.2 Transport

The backend exposes two endpoints. The Vite dev server proxies `/api` to `VITE_API_TARGET`.

- `GET /api/runs` returns `{ runs: { id, objective, status, startedAt, mock?: boolean }[] }`, newest first. `mock: true` means the backend itself is serving fake data, and the dashboard must label it.
- `GET /api/runs/:runId/events` is an SSE stream. The server first sends every event with `seq` greater than the resume point, then streams new events as they happen. The resume point comes from the `Last-Event-ID` header or an `?after=<seq>` query, defaulting to 0. Each SSE message carries `id: <seq>` and `data: <RunEvent JSON>`, and the server sends a `: ping` comment every 15 seconds.

Runs are small (a few thousand events), so the dashboard folds the full log from `seq` 0. Add a snapshot endpoint later only if that becomes slow.

The browser's `EventSource` reconnects on its own and sends `Last-Event-ID`. Delivery can still repeat, so the reducer ignores any event whose `seq` is not greater than the last one applied.

### 4.3 What the dashboard needs from the backend

Share this table with the backend team. It lists which part of the system is best placed to record each event.

| Event | Recorded by | When |
| --- | --- | --- |
| `run.state` | backend | CLI starts the run, `finish_run` is accepted, cleanup finishes, deadline or stop |
| `agent.spawned` | backend | a spawn is admitted and the agent record is reserved |
| `agent.state`, `checkpoint` | Temporal activities and the sandbox worker | around each invocation, checkpoint, recovery or inspection flag |
| `sandbox.state` | Temporal activities | Modal provision, suspend, terminate, replace |
| `agent.woken` | Temporal activity that starts an invocation | when a signal or timer causes the invocation |
| `message.sent`, `delivery.*` | backend messaging API | in the same transaction as the message |
| `task.upserted` | backend task API | create, claim and every status change |
| `tool.called`, `usage` | sandbox worker, reported through the backend | each Pi tool call, each finished invocation |
| `git.pushed`, `verification.recorded` | backend, from agent tool calls | after a push succeeds, when a check result is recorded |
| `worker.restarted` | Temporal worker | on startup |
| `failure.recorded` | wherever a failure is persisted or resolved | provisioning, relay, recovery, cleanup failures |

## 5. State model

### 5.1 Run state

```ts
// src/state/reduce.ts
export interface AgentView {
  id: AgentId;
  role: string;
  kind: "orchestrator" | "worker";
  spawnedBy?: AgentId;
  joinedSeq: number;
  state: AgentState;
  stateSince: string;
  generation: number;
  invocationId?: string;
  wakeAt?: string;
  detail?: string;
  sandbox?: { id: string; state: SandboxState; previousIds: string[] };
  pendingDeliveries: string[];
  lastTool?: { tool: string; summary: string; ts: string };
  lastWake?: { reason: WakeReason; seq: number; causedBy?: string };
  checkpointVersion?: number;
  stateHistory: { seq: number; ts: string; state: AgentState; generation: number; detail?: string }[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number };
}

export interface RunState {
  runId: string;
  run?: { status: RunStatus; objective?: string; repo?: string; workerLimit?: number;
          startedAt?: string; endedAt?: string; finalCommit?: string; outcome?: string };
  agents: Record<AgentId, AgentView>;
  agentOrder: AgentId[];                 // orchestrator first, then by joinedSeq
  tasks: Record<string, Task & { createdSeq: number;
          history: { seq: number; ts: string; status: TaskStatus; ownerId?: AgentId; resultCommit?: string }[] }>;
  messages: { id: string; seq: number; ts: string; channelId: string; channelKind: "team" | "dm";
              from: AgentId; to: AgentId[]; body: string; replyTo?: string }[];
  channels: Record<string, { id: string; kind: "team" | "dm"; members: AgentId[]; lastSeq: number }>;
  peerLinks: Record<string, { a: AgentId; b: AgentId; count: number; lastSeq: number }>; // key "a|b", sorted
  commits: Record<string, { sha: string; branch?: string; agentId?: AgentId; ts?: string; message?: string;
            verifications: { seq: number; ts: string; agentId?: AgentId; command: string;
                             passed: boolean; summary?: string }[] }>;
  failures: Record<string, { id: string; seq: number; ts: string; agentId?: AgentId;
            scope: string; message: string; resolved: boolean }>;
  workerRestarts: { seq: number; ts: string }[];
  skippedEvents: number;
  lastSeq: number;
}
```

### 5.2 Reducer rules

`reduce(state, event)` is pure and is the only write path into run state.

1. Ignore events with `seq <= state.lastSeq`, then set `lastSeq`.
2. `run.state` merges fields into `run`. The first one sets `startedAt`, and terminal statuses set `endedAt`.
3. `agent.spawned` creates the agent with state `provisioning` and generation 0, unless an event for that agent already created a placeholder, in which case it fills in role, kind and `spawnedBy`.
4. Any event naming an unknown `agentId` creates a placeholder agent with role `"unknown"`. Out-of-order events must never crash the reducer.
5. `agent.state` sets state, generation, `wakeAt`, `detail` and `invocationId`, and appends to `stateHistory`. Clear `wakeAt` when the state leaves `waiting`.
6. `sandbox.state` with a new `sandboxId` pushes the old ID onto `previousIds`.
7. `agent.woken` sets `lastWake`.
8. `checkpoint` sets `checkpointVersion`.
9. `message.sent` appends the message and creates or updates its channel. A team channel's members are all agents, and a DM channel's members are `from` plus `to`. For `channelKind: "dm"` only, increment `peerLinks` for the pair. Team messages and mentions never create peer links.
10. `delivery.queued` adds the delivery ID to the recipient's `pendingDeliveries`, and `delivery.done` removes it.
11. `task.upserted` replaces the task, keeps `createdSeq`, and appends to `history` when status, owner or result commit changed.
12. `tool.called` sets `lastTool`.
13. `git.pushed` creates or fills the commit. `verification.recorded` appends to the commit's verifications, creating a placeholder commit if the push hasn't arrived yet.
14. `usage` adds to the agent's totals.
15. `worker.restarted` appends to `workerRestarts`.
16. `failure.recorded` upserts by `failureId`.

### 5.3 Selectors

Selectors in `selectors.ts` derive everything the components render. None of them mutate state.

- `selectCounters` returns agents awake (state `running`, `checkpointing` or `recovering`) out of total, message count, tasks done out of total, total tokens, total cost and elapsed time.
- `selectSlots` returns canvas slot assignments (section 7.1).
- `selectPeerEdges` returns peer links with stroke widths.
- `selectHandoff` returns, per task, a merged list of task history, pushes of its result commits and verifications of those commits, ordered by `seq`.
- `selectRecovery` returns worker restarts, sandbox replacements (agent, old ID, new ID, generation) and failures.
- `selectFeed(filter)` returns formatted timeline rows (section 9.2).

### 5.4 Playback

The playback controller owns a cursor into the event list. The rendered state is always `fold(events[0..cursor])`.

- Sources only append events. They never touch the cursor.
- Modes are `follow` (live, cursor stays at the newest event), `playing` (replay or mock, cursor advances on a timer) and `paused`.
- Speeds are 1×, 2×, 4× and 8×.
- While playing, the delay before event `i` is `min(ts[i] − ts[i−1], 1200 ms) / speed`, with a floor of 40 ms. Long model calls would otherwise leave the screen idle for a minute.
- Animations (section 7.6) fire only when the cursor moves forward by normal playback or live following. A scrub, a click in the feed or any backward move updates state without animating.
- Cache the folded state every 200 events so scrubbing stays fast. At this scale it's optional.

Live sources start in `follow`. Mock and replay sources start in `playing` from the first event.

## 6. Screen layout

The page is a CSS grid with rows `auto 1fr 200px` and columns `1fr 400px`. The top bar spans both columns, and the timeline spans both columns at the bottom. At 1280 px wide the inspector is 360 px. Below 1024 px, the inspector and timeline stack under the canvas, and no further mobile work is needed.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ atoi   Handle quoted newlines in the CSV parser         running   14:02   live        │
│        agents 2/3 awake   messages 41   tasks 1/2   tokens 182k   cost $0.41          │
├────────────────────────────────────────────────────────────┬─────────────────────────┤
│                                                            │ summary  tasks  chat  git│
│                     ┌────────────────┐                     │                         │
│                     │ orchestrator   │                     │ objective               │
│                     └───────┬────────┘                     │ handoff                 │
│                             ┊                              │   13:52 T1 claimed      │
│                     ┌───────┴────────┐                     │   13:55 pushed a1b2c3d  │
│                     │  shared state  │                     │   13:57 test failed     │
│                     │ git·tasks·chat │                     │   ...                   │
│                     └──┬──────────┬──┘                     │ result                  │
│              ┊┄┄┄┄┄┄┄┄┄┘          └┄┄┄┄┄┄┄┄┄┊              │ recovery and failures   │
│      ┌───────┴──────┐                ┌──────┴───────┐      │ usage                   │
│      │ implementer  │──── 1 hop ────▶│   reviewer   │      │                         │
│      └──────────────┘                └──────────────┘      │                         │
├────────────────────────────────────────────────────────────┴─────────────────────────┤
│ ▶ 2×   ├────●───|──────|───────|──────────────────────────────────┤   live           │
│ 13:55:12  implementer → reviewer   dm      T1 is ready for review at a1b2c3d           │
│ 13:55:13  reviewer                 woke    dm from implementer                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 7. Mesh canvas

### 7.1 Geometry

Use flow coordinates with the hub centered at (0, 0). Agents sit on an ellipse with `rx = 440` and `ry = 250`.

- The slot count is `1 + run.workerLimit` when the limit is known, and grows to the agent count if agents exceed it. Without a limit, it equals the agent count.
- Slot `i` sits at angle `−90° + i × 360° / slotCount`, so slot 0 is at the top. Agents fill slots in `agentOrder`, which puts the orchestrator at the top.
- Unfilled slots render as faint dashed outlines labeled "open slot", which shows the worker limit and remaining capacity at a glance. A newly spawned agent takes its slot immediately and shows its provisioning state.
- If the slot count changes, cards glide to their new positions over 400 ms.
- Nodes are not draggable. Allow pan and zoom, and call `fitView` with padding on load and whenever the slot count changes.

Put all position and path math in `canvas/geometry.ts`. Both the edge components and the activity layer use it, so a moving message dot always follows exactly the drawn line.

- A spoke is a straight line from the card's edge toward the hub's edge.
- A peer link is a quadratic curve. Its control point is the segment midpoint pushed away from the hub center by 0.25 × the segment length. If the midpoint is within 1 unit of the center, push it perpendicular to the segment instead. This keeps peer links from crossing the hub.

### 7.2 Hub node

The hub is 280×110, filled with `--hub`, with a 2 px ink border and square corners like the sketch. It shows "shared state" in 16 px semibold mono and "git · tasks · chat" below it, matching the sketch's label. Under that, three small clickable counts show tasks done out of total, commits pushed and chat messages. Each count opens the matching inspector tab. Text on the hub uses ink for contrast.

### 7.3 Agent card

Cards are 240×120 with a 2 px radius, no shadow, and `--card` fill.

```
┌──────────────────────────────┐
│ reviewer                gen 2│   role in 16px semibold, generation badge on the right
│ ▍running   bash: npm test    │   state marker and label, then the activity line
│ ✉ 1        ⏱ 3:12            │   pending deliveries, wake countdown when waiting
├──────────────────────────────┤
│ sandbox sb-9d4   running     │   sandbox strip, 13px
└──────────────────────────────┘
```

- The orchestrator's card adds a small "orchestrator" tag after the role, in muted text. The tag carries the distinction, so the card uses no special color.
- The activity line shows `lastTool` (`tool: summary`, truncated to fit) while running, the checkpoint version while checkpointing, `detail` while recovering, needing inspection or failed, and "idle 4m" while waiting with no timer.
- The countdown is shown only when `wakeAt` is set and counts down to it.
- Hide the ✉ badge when nothing is pending.
- Show `gen n` only once the generation is above 1.
- On hover, show the agent ID. Clicking a card opens agent detail in the inspector.
- Selection draws a 3 px ink outline offset 3 px from the card.

### 7.4 States

| Agent state | Border | Fill | Label |
| --- | --- | --- | --- |
| provisioning | 1.5 px dashed `--line` | `--paper` | provisioning |
| waiting | 1.5 px solid `--ink` | `--card` | waiting |
| running | 2.5 px solid `--accent` | `--card` | running |
| checkpointing | 2.5 px solid `--accent` | `--card` | saving checkpoint |
| recovering | 2.5 px solid `--amber` | `--card` | recovering |
| needs_inspection | 2.5 px solid `--red` | `--red-tint` | needs inspection |
| failed | 2.5 px dashed `--red` | `--card` | failed |
| stopped | 1.5 px solid `--line`, 55% opacity | `--paper` | stopped |

The state marker is a 4 px vertical bar in the border color, followed by the label in lowercase. Never use color alone, so the label is always visible.

| Sandbox state | Strip text |
| --- | --- |
| starting | `sandbox sb-9d4  starting` in `--amber` |
| running | `sandbox sb-9d4  running` with a small filled dot |
| suspended | `sandbox sb-9d4  suspended` in `--muted` with a hollow dot |
| terminated | the ID struck through, in `--muted` |

After a replacement, the strip shows `sandbox sb-9d4 (was sb-2c3)` for 10 seconds of playback time. The full list of previous IDs lives in agent detail.

### 7.5 Edges

- Spokes connect every agent to the hub with a 1.5 px dotted `--line` stroke (`stroke-dasharray: 2 6`). They are present from the moment the agent joins.
- Peer links appear on the pair's first DM, drawn on over 300 ms with a `stroke-dashoffset` reveal. The stroke is solid `--ink` with width `2 + min(4, log2(count))` px, and a small count chip sits at the curve midpoint. Clicking a link opens the DM thread.
- Spawn connectors draw a dashed `--accent` line from the spawning agent to the new agent's slot for 2.5 seconds while the new card fades in, then remove it.

### 7.6 Activity animations

These are the only animations. Each one is triggered by a specific event during forward playback.

| Trigger | Animation |
| --- | --- |
| `message.sent`, DM | An 8 px `--accent` dot travels the peer link from sender to recipient in 900 ms ÷ speed (minimum 250 ms). A callout chip near the midpoint reads `1 hop` plus the first 48 characters of the body, and stays for 2.5 s. This is the sketch's "1 hop" moment. |
| `message.sent`, team | A dot travels the sender's spoke into the hub, and the hub's chat count briefly turns `--accent`. If `to` is not empty, dots then travel out along each addressed agent's spoke, and the callout reads `team chat`. |
| `agent.woken` | One `--accent` ring pulse around the card (600 ms) and a chip reading `woke · dm`, `woke · mention` or `woke · timer` with ✉, @ or ⏱ for 3 s. If `causedBy` matches a message whose dot is still moving, wait until the dot arrives. |
| `task.upserted`, `git.pushed`, `verification.recorded` | The agent's spoke turns `--accent` at 2.5 px for 1.2 s, and the matching hub count flashes. |
| `agent.spawned` with `spawnedBy` | Spawn connector plus a 300 ms fade-in of the card. |
| generation increases | The `gen` badge gets an `--amber-tint` background that fades out over 3 s. |
| `worker.restarted` | An amber banner across the top of the canvas reads "Temporal worker restarted at 14:03:22" for 6 s. |

Callout and wake chips use `--ink` text on `--accent-tint` with a 1 px `--accent` border. Render dots and chips in an overlay layer inside React Flow's viewport (for example `ViewportPortal`), animated with `requestAnimationFrame` along paths from `geometry.ts`. With `prefers-reduced-motion`, skip moving dots and pulses and instead highlight the edge or card statically for the same duration.

## 8. Inspector

The inspector has four tabs, "summary", "tasks", "chat" and "git", plus detail views that open on top of them with a close button. Esc closes a detail view. Number keys 1 to 4 switch tabs.

**Summary** is the default and shows:
- the objective, repo, run status, elapsed time, and how many workers are in use out of the limit;
- the handoff for each task, as a vertical timeline from `selectHandoff`, for example "13:52 claimed by implementer", "13:55 pushed a1b2c3d to task/T1", "13:57 reviewer ran npm test on a1b2c3d, failed (13 passed, 1 failed)", "14:02 done";
- the result, which is the final commit, the outcome text from `run.state`, and the latest verification on the final commit;
- recovery and failures, listing worker restarts, sandbox replacements (agent, old and new sandbox, generation) and recorded failures, with unresolved failures in `--red` and resolved ones in `--muted` marked "resolved";
- usage per agent (tokens, cost, active time) and totals.

**Tasks** groups tasks by status in the order in progress, in review, blocked, open, done, each group with a count. A row shows the title, owner, result commit chip and dependency count. Clicking a row expands it to show the description, acceptance criteria and status history. The panel is narrow, so use a grouped list rather than a five-column board.

**Chat** has a channel switcher with "team" plus one entry per DM pair ("implementer ↔ reviewer"). Messages show the sender, time and body. Highlight @mentions in `--accent`. Turn known commit SHAs (any 7 to 40 character hex string that prefix-matches a known commit) and known task IDs into clickable chips. Only link IDs that exist in state.

**Git** lists commits newest first, each with its SHA chip, branch, author agent, time and message. Verifications appear under each commit with ✓ or ✗, the command, the summary and which agent ran it.

**Agent detail** shows role, kind, ID, generation, the current sandbox and its previous IDs, state history, the last 30 tool calls, pending inbox messages with sender and preview, owned tasks, wake history and usage. A button filters the timeline to this agent.

**Thread detail** shows the DM thread for a peer link in chronological order, rendered like Chat.

Chips for agents, tasks and commits work everywhere and select their target.

## 9. Timeline

### 9.1 Scrubber

The scrubber row holds a play/pause button, a speed selector, a track spanning the run's time range, and a live control at the right.

- Markers on the track show spawns (ink), pushes (accent), verifications (green or red), wakes (hollow accent), restarts and replacements (amber), and failures (red). Hovering a marker shows its feed line.
- Dragging the thumb moves the cursor.
- In live mode, the control shows "live" with a pulsing dot while following. After the user scrubs back, it reads "Jump to live".
- Keyboard shortcuts are Space (play/pause), ← and → (one event), Shift with ← or → (ten events) and L (jump to live).
- The timeline collapses to just the scrubber row.

### 9.2 Event feed

The feed shows one line per event up to the cursor, in mono with tabular figures. Its format matches the CLI event log, so the two read the same.

```
13:55:12  implementer → reviewer   dm       T1 is ready for review at a1b2c3d on task/T1
13:55:13  reviewer                 woke     dm from implementer
13:55:40  reviewer                 tool     bash: npm test
13:56:02  reviewer                 verify   a1b2c3d npm test failed (13 passed, 1 failed)
14:03:22  system                   restart  Temporal worker restarted
```

| Event | Actor | Verb | Text |
| --- | --- | --- | --- |
| `run.state` | system | run | status, plus the final commit when present |
| `agent.spawned` | spawner, or "cli" | spawn | `reviewer joined` |
| `agent.state` | agent | state | state, generation if above 1, `wakeAt`, detail |
| `sandbox.state` | agent | sandbox | `sb-9d4 running` |
| `agent.woken` | agent | woke | `dm from implementer`, `mention from orchestrator`, `timer` |
| `checkpoint` | agent | checkpoint | `saved v5` or `restored v5` |
| `message.sent` | `from → to` for DMs, `from` for team | dm or team | first line of the body, up to 100 characters |
| `delivery.*` | recipient | inbox | `queued` or `done`, with the sender |
| `task.upserted` | owner or `agentId` | task | `T1 in review (a1b2c3d)` |
| `tool.called` | agent | tool | `tool: summary` |
| `git.pushed` | agent | push | `a1b2c3d to task/T1` |
| `verification.recorded` | agent | verify | `a1b2c3d npm test passed (15 passed)` |
| `usage` | agent | usage | tokens and cost |
| `worker.restarted` | system | restart | `Temporal worker restarted` |
| `failure.recorded` | agent or system | failure | `[relay] message`, plus "resolved" when resolved |

Filter chips are all, messages, tasks, git, lifecycle, tools and failures. "All" leaves out `delivery.*` and `usage`, which only appear under lifecycle. Clicking a row moves the cursor to that event and selects the related agent, task or commit. The feed auto-scrolls while the cursor is at the newest event. When the user scrolls up, auto-scroll stops and a "Newest" button appears. The feed header shows "n events skipped" when any malformed events were dropped.

## 10. Top bar and data labeling

The top bar shows the "atoi" wordmark, the run objective (truncated, with the full text on hover), and the run status in the same marker style as agent states. On the right are the counters from `selectCounters`, each a value with a small lowercase label beneath it, then the elapsed time and the source label. A run picker appears when `/api/runs` returns more than one run.

Sources are labeled so nobody mistakes test data for a real run.

| Source | Label |
| --- | --- |
| live backend | "live" with an `--accent` dot in the top bar |
| replay of a recorded real run | "replay of run r_8f2, recorded 14:10" in the top bar |
| fixture, fake SSE server, or a backend run with `mock: true` | a full-width `--amber-tint` strip above the top bar with `--ink` text reading "Mock data. This is a scripted fixture, not a live run." (for the fake server, "Mock data from a local test stream."). The strip cannot be dismissed. |

## 11. Visual system

### 11.1 Direction

The sketch sets the direction with warm paper, square boxes, lowercase monospace labels, dotted lines to shared state, solid lines between peers, and one steel-blue accent for the live path. Keep it flat and quiet so activity stands out.

1. Blue means work happening now. `--accent` is reserved for running agents, messages in flight, wake pulses and the live indicator, so a glance at the screen shows where the work is.
2. The mesh grows from real messages. Peer links appear only when agents DM, so the network on screen is the one that actually formed.
3. State lives in the hub and work lives at the edges.
4. The agent and its sandbox are shown as two different things, because the agent is durable and the sandbox is replaceable.
5. The screen shows recorded facts. Copy never claims anything an event doesn't say.

### 11.2 Tokens

Base colors were sampled from the sketch. `--line` is darker than the sketch's dotted gray so it survives a projector.

| Token | Hex | Use |
| --- | --- | --- |
| `--paper` | `#eae7de` | page background |
| `--card` | `#f3f1ea` | cards, panels |
| `--hub` | `#dbd9d2` | hub fill, selected rows |
| `--ink` | `#292a27` | text, borders, peer links |
| `--muted` | `#5b625f` | secondary text on paper and card only |
| `--line` | `#72726d` | spokes, dividers, dashed outlines |
| `--accent` | `#3b6d84` | live activity only |
| `--accent-tint` | `#d5d9d4` | callout chips, selected agent background |
| `--amber` | `#8a5a12` | provisioning, recovering, sandbox starting, restarts |
| `--amber-tint` | `#efe2c6` | mock strip, generation highlight |
| `--red` | `#9b3426` | needs inspection, failures, failed checks |
| `--red-tint` | `#f1dcd5` | needs-inspection card fill |
| `--green` | `#3f6b3a` | passed checks only |

Measured contrast of `--ink` is 11.7:1 on paper and 12.8:1 on card. `--muted` is 5.1:1 on paper and 5.5:1 on card. `--accent` is 4.6:1 on paper and 5.0:1 on card. `--amber`, `--red` and `--green` all exceed 4.7:1 on paper. `--line` is 3.9:1 on paper, which is enough for lines and outlines but not for text. On the hub, `--accent-tint` and `--amber-tint`, use `--ink` for text, since `--accent` on `--accent-tint` is only 4.0:1.

### 11.3 Type

- IBM Plex Mono is used for labels, IDs, counters, the feed, card text and timestamps, at weights 400, 500 and 600.
- IBM Plex Sans is used for message bodies, task descriptions and other prose longer than one line, at weights 400 and 500.
- The scale is 13 px (sandbox strip, timestamps, chips; nothing smaller), 14 px (feed, inspector body), 16 px (card and hub titles, tabs), 18 px (wordmark, objective, counter values).
- Labels are lowercase like the sketch, and sentences use sentence case. Avoid all-caps labels and letter-spaced eyebrows.
- Use tabular figures for counters and times.

### 11.4 Shape, focus and motion

- Borders are 1.5 to 2.5 px with a 2 px radius at most. Use no shadows or gradients.
- Focus rings are a 2 px `--accent` outline offset 2 px on every interactive element. Tab moves through agents on the canvas in slot order.
- Motion is limited to the triggers in section 7.6 and the 400 ms slot glide. Use ease-out, and respect `prefers-reduced-motion`.

## 12. Sources and fixtures

### 12.1 Source interface

```ts
// src/sources/types.ts
export type SourceKind = "live" | "replay" | "mock";
export interface SourceStatus {
  state: "connecting" | "open" | "reconnecting" | "closed" | "error";
  retryInMs?: number;
  message?: string;
}
export interface RunSource {
  kind: SourceKind;
  label: string;   // shown in the top bar or mock strip
  start(onEvent: (e: RunEvent) => void, onStatus: (s: SourceStatus) => void): () => void; // returns stop
}
```

- `FixtureSource` fetches an NDJSON file and emits every event at once. The playback controller handles timing. Use kind `mock` for fixtures and `replay` for recordings.
- `LiveSource` opens an `EventSource` on `/api/runs/:runId/events`. It maps `onerror` to `reconnecting` while the browser retries. If the stream closes for good (a 404 or 500 on connect), it reports `error`, and "Retry now" opens a new stream with `?after=<lastSeq>`.
- The URL selects the source. Use `?source=mock&fixture=recovery`, `?source=replay&file=/recordings/r_8f2.ndjson`, or `?source=live&run=r_8f2`. Without `run`, live mode picks the newest run from `/api/runs`. With no parameters, use `VITE_DEFAULT_SOURCE`, which defaults to `mock`.

### 12.2 Scripts

- `npm run fixtures` runs `scripts/build-fixtures.ts`, which writes `public/fixtures/*.ndjson`.
- `npm run fake-sse -- --fixture recovery --speed 4 [--drop-after 30]` starts `scripts/fake-sse.ts`, a plain Node HTTP server implementing both endpoints from section 4.2 from a fixture. It honors `Last-Event-ID` and `?after`, paces events with the same gap compression as playback, and sends pings. `--drop-after` closes the connection after N events so reconnects can be tested. `/api/runs` returns `mock: true`, so the dashboard shows the mock strip.
- `npm run record -- --run r_8f2` runs `scripts/record.ts`, which reads a live run's stream from `seq` 0 and writes `public/recordings/<run>.ndjson` until the run reaches a terminal status. A recording of a real run is the demo fallback.

### 12.3 Fixture builder

Fixtures are TypeScript so they stay consistent and readable. The builder assigns `seq`, `runId` and `ts` from a start time plus a running offset.

```ts
// fixtures/builder.ts (sketch)
const f = fixture({ runId: "r_demo", start: "2026-10-11T13:50:00Z" });
f.after(2, { type: "agent.spawned", agentId: "a_rev", role: "reviewer", kind: "worker", spawnedBy: "a_orch" });
f.dm(1, { from: "a_impl", to: "a_rev", body: "T1 is ready for review at a1b2c3d on task/T1." });
// dm() emits message.sent plus delivery.queued for the recipient
```

Add helpers for the common combinations, such as `dm`, `team` (with mentions), `wake`, `push` and `verify`. `wake` sets `causedBy` to the triggering message ID (or a timer ID), which the feed and the wake animation rely on. When a woken agent finishes handling a message, emit `delivery.done` for that delivery so inbox badges drain. Each fixture should also emit a `usage` event after each invocation, with plausible numbers (4k to 20k tokens and $0.01 to $0.06 each).

Use agent IDs `a_orch`, `a_impl`, `a_rev` and `a_spec`, sandbox IDs like `sb-0a1`, the repo `atoi-demo/csv-parser`, and these tasks.

- T1 "Handle quoted newlines in CSV fields", with acceptance criteria "`parse('\"a\nb\",c')` returns `[['a\nb', 'c']]`" and "existing tests still pass".
- T2 "Add a regression test for CRLF inside quoted fields", created by the implementer partway through.

### 12.4 Fixture: happy-path

1. `run.state` starting, then running, with the objective, repo and `workerLimit: 2`.
2. The orchestrator spawns with no `spawnedBy`. Its sandbox goes from starting to running, and it starts running at generation 1.
3. The orchestrator calls `create_task` and upserts T1 as open.
4. The orchestrator spawns the implementer and then the reviewer. Each provisions, gets a running sandbox, and goes to waiting.
5. The orchestrator posts to the team channel, "@implementer please take T1. @reviewer review it once it's in review." Both get deliveries and wake by mention. The orchestrator goes to waiting.
6. The reviewer reads the channel, saves checkpoint v1, and waits. The implementer claims T1, which becomes in progress with the implementer as owner.
7. The implementer runs tools (`bash: git checkout -b task/T1`, `read: src/parse.ts`, `edit: src/parse.ts`, `bash: npm test`), pushes `a1b2c3d` to `task/T1`, records a passing verification (14 passed), and moves T1 to in review with result commit `a1b2c3d`.
8. The implementer DMs the reviewer, "T1 is ready for review at a1b2c3d on task/T1." This is the first DM, so the peer link appears. The implementer saves a checkpoint and waits.
9. The reviewer wakes on the DM, runs `bash: git fetch origin && git checkout a1b2c3d` and `bash: npm test`, and records a failed verification on `a1b2c3d` (13 passed, 1 failed, "quoted field with CRLF"). It DMs back, "a1b2c3d fails when a quoted field contains \r\n (parse_crlf_quoted). Can you handle CRLF too?"
10. The implementer wakes on the DM, moves T1 back to in progress, creates T2 and claims it, edits, tests, pushes `b4e5f6a`, records a passing verification (15 passed), marks T2 done, moves T1 to in review with `b4e5f6a`, and DMs, "Fixed in b4e5f6a. T2 adds parse_crlf_quoted coverage."
11. The reviewer wakes on the DM, fetches and tests `b4e5f6a`, records a passing verification (15 passed), marks T1 done, posts "@orchestrator T1 is approved at b4e5f6a." to the team channel, saves a checkpoint, and waits.
12. The orchestrator wakes by mention, lists tasks, and sets `run.state` to completing with final commit `b4e5f6a` and outcome "T1 reviewed and approved on task/T1 at b4e5f6a".
13. Every agent saves a checkpoint and stops, every sandbox terminates, and the run is completed.

### 12.5 Fixture: recovery

This fixture is self-contained, so start with a quick setup.

1. The run starts, three agents spawn and get running sandboxes, and all three are waiting. The reviewer has saved checkpoint v3 and its sandbox is suspended.
2. The implementer DMs the reviewer, "Quick check: does T1 need the Windows fixture?" The reviewer gets a delivery, wakes by DM, its sandbox resumes running, it replies, the delivery completes, and it saves v4. It then waits with `wakeAt` two minutes out, with the detail "re-run the full suite in 2 minutes", and its sandbox is suspended.
3. Two minutes later the reviewer wakes by timer, runs `bash: npm test`, saves v5, and waits.
4. The implementer DMs the reviewer, the delivery is queued, and the Temporal worker restarts. After the restart, the reviewer wakes by DM in a single invocation with one `invocationId`, completes the delivery, and waits.
5. The reviewer's sandbox `sb-2c3` terminates, and the reviewer goes to recovering at generation 2 with the detail "replacing sandbox". While it recovers, the implementer DMs, "Follow-up: please also check the empty-file case." The reviewer's ✉ badge shows 1.
6. Sandbox `sb-9d4` starts and runs, and checkpoint v5 is restored. The reviewer wakes by DM, runs `bash: git fetch origin`, completes the delivery so the badge clears, replies "Checked the empty-file case on b4e5f6a. It passes.", saves v6, and waits.
7. A relay failure is recorded unresolved ("Wakeup for delivery d_31 failed to send"), then the same `failureId` is recorded again as resolved ("Reconciler resent the wakeup for d_31").

### 12.6 Fixture: third-worker

Start like happy-path but with `workerLimit: 3`. Partway through, the orchestrator spawns `a_spec` with role "specialist". The specialist lists agents, DMs the implementer, claims T2 and completes it. This checks that four agents lay out cleanly and that the open slot fills in without code changes.

### 12.7 Fixture: edge-states

This fixture is for visual QA, not the demo. It covers a provisioning failure (an agent that goes to failed, plus an unresolved provisioning failure), an agent that ends in `needs_inspection` with the detail "Interrupted during git push. The push may or may not have landed.", a blocked task with a dependency, a stopped agent, and an event with an unknown `type`, which must show as "unknown" in the feed without breaking anything.

## 13. Empty, loading and error states

| Situation | What to show |
| --- | --- |
| No runs on the backend | "No runs yet. Start one from the CLI and it will appear here." Poll `/api/runs` every 5 s. |
| Connecting | The hub alone, with "Connecting to run r_8f2…" |
| Run not found | "Run r_8f2 isn't on the backend. Pick another run." with the run picker |
| Connection lost | A strip reading "Lost connection to the backend. Retrying in 4s." with a "Retry now" button |
| Fixture missing | "Couldn't load fixtures/recovery.ndjson (404). Run npm run fixtures to generate it." |
| Malformed events | Skip them, log to the console, and show "n events skipped" in the feed header |
| Run finished | Keep the final canvas, show the terminal status in the top bar and the result in Summary |

## 14. Out of scope for now

- Operator controls such as stopping a run, killing a sandbox, restarting the worker or spawning agents. Those stay in the CLI. If the backend later exposes the same operations over HTTP, add buttons that call them.
- Authentication and multiple viewers.
- Editing tasks or sending messages from the browser.
- Nested sub-agent clusters. Agents spawned by workers still render as normal agents in a slot. Later, agents whose `spawnedBy` is a worker can render as small boxes under their parent, like the sketch.
- Semantic search, run comparison, a dark theme and a dedicated mobile layout.

## 15. Build order

Build in vertical slices so the app runs end to end after every step.

1. Scaffold the app with tokens, fonts and the static layout shell from section 6.
2. Write the contract types and zod schemas, the reducer, selectors and their tests, the fixture builder and the happy-path fixture.
3. Add the playback controller, `FixtureSource`, the event feed, the top bar counters and the mock strip. Playing the fixture should now update the feed and counters.
4. Build the static canvas with the hub, slots, agent cards, spokes and peer links bound to state.
5. Add the activity layer with message dots and callouts, wake pulses, spawn connectors, hub flashes, the generation highlight, the restart banner and the reduced-motion fallback.
6. Build the inspector with Summary, Tasks, Chat, Git, agent detail and thread detail.
7. Add the scrubber with markers, speeds, keyboard shortcuts and click-to-seek from the feed.
8. Add the recovery, third-worker and edge-states fixtures, then do visual QA at 1280×720 and 1920×1080.
9. Add `LiveSource`, run selection, the fake SSE server and the record script, then test reconnects with `--drop-after`.
10. Connect to the real backend when it exists, and record a real run for replay.

## 16. Acceptance checks

Report which of these actually ran and their results. A check that passes against mock data does not show that the live backend integration works.

1. `typecheck`, `build` and `test` all pass.
2. Reducer tests cover duplicate `seq` being ignored, unknown event types, placeholder agents for out-of-order events, delivery queue and drain, peer links counting DMs only, generation and sandbox ID history, task history, verifications arriving before their push, and failure upserts.
3. Folding the full log once gives the same state as applying events one at a time with the playback controller, for every fixture.
4. Happy-path plays to completion with three agents. The final commit `b4e5f6a`, the outcome and the passing verification show in Summary.
5. The implementer–reviewer peer link appears only at the first DM and thickens with later DMs. Team messages and mentions never create peer links.
6. Recovery visibly shows a DM wake, a timer wake with a countdown, the restart banner, the sandbox ID change with the generation going from 1 to 2, and the ✉ badge going from 1 to 0.
7. Third-worker fills the open slot with no code changes, and nothing overlaps at 1280×720.
8. Edge-states renders every agent state, both failure styles, the blocked task and the unknown event without errors.
9. Scrubbing to any point shows a consistent state, and scrubbing never triggers animations.
10. The mock strip is visible for fixtures, the fake SSE server and any run marked `mock`. Replays say "replay" with the run ID.
11. With `fake-sse --drop-after 30`, the dashboard reconnects and finishes the run with no duplicate feed rows.
12. Under `prefers-reduced-motion`, no dots move and no cards pulse, but every highlight still appears.
13. All text meets the contrast values in section 11.2, and every interactive element has a visible focus ring.
14. Screenshots of each fixture's final state at 1280×720 and 1920×1080 are attached when the work is reviewed.
