# atoi dashboard

A live view of one atoi run: a mesh canvas of agents around shared state, a Slack-style chat
that is the main way to read what the team is doing, and a direct line from you to the
orchestrator. It started from [`atoi-dashboard-plan.md`](../atoi-dashboard-plan.md); the
product changes since then are listed below.

**Status: connected to the authenticated backend.** The live UI launches an orchestrator,
shows recorded activity and task evidence, sends team posts or direct operator messages,
and stops runs. Objective completion leaves the team available for follow-up messages.
Only explicit Stop or the team deadline ends it. Offline fixtures and an explicitly simulated backend demo remain available.
A simulated run does not establish Atlas, model, Git or Modal integration.

## Setup

The dashboard is a pnpm workspace package. From the repo root (Node.js 24+, pnpm 11.19.0,
as for the rest of the repo):

```bash
pnpm install --frozen-lockfile
pnpm --filter atoi-dashboard dev        # http://localhost:5173
```

The commands below run from `dashboard/` with `pnpm <script>`, or from the root with
`pnpm --filter atoi-dashboard <script>`.

Copy `.env.example` to `.env` to change defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_API_TARGET` | `http://127.0.0.1:3000` | Where the dev server proxies `/api` |
| `VITE_DEFAULT_SOURCE` | `live` | Source used when the URL has no `?source=` |

## Using it

Start `pnpm dev:live`, then `VITE_API_TARGET=http://127.0.0.1:3200 pnpm dev:dashboard`,
as described in [runtime setup](../docs/runtime.md). The launcher stays up across
objectives. Do not use `pnpm e2e` as the interactive backend.
Open the dashboard and enter `ADMIN_TOKEN` (stored in this tab's session storage),
a configured writable repository and a bounded objective. The orchestrator uses one sandbox
in addition to the configured worker limit. Closing the tab does not stop cloud compute;
use **Stop**, or wait for the team deadline. Objective completion keeps the team available. **New run** opens another launch.
Existing runs can be selected from the top bar.


- **Canvas.** Agents sit on a ring around the shared-state hub. A solid line appears between
  two agents once they DM each other. The **you** node is linked to the orchestrator.
- **Chat (right).** Shows **#team** by default: every team message plus milestones (agents
  joining, task status changes, sandbox replacements, worker restarts, failures, run start
  and end). Select a line on the canvas, or its count chip, to show that **DM** instead.
  DMs show the pair's messages; tick **activity** to interleave both agents' wakes, tool
  calls, pushes, test results, checkpoints and sleeps between them.
  Select the line again, click empty canvas, or press Esc to go back to #team.
- **Talking to the orchestrator.** Click **you**, the you–orchestrator line, or **Message
  orchestrator**. Type and press Enter (Shift+Enter for a new line). Your message shows as
  "sending…" until the backend records it and it comes back on the event stream.
- **Talking to a worker.** Open its agent details and choose **Message implementer/reviewer**
  (or its configured role). This opens your own DM with that agent; peer-to-peer conversations
  remain read-only to the operator.
- **Details.** Click an agent card, a hub count, or **details** (or press 1–3) for the summary,
  tasks, git, and agent detail drawer. Esc closes it.

## Themes

The **theme** menu on the canvas (next to **details**) or a `&theme=` URL parameter switches
themes in place. The choice stays in the URL.

| Theme | URL | Look |
| --- | --- | --- |
| tensorlake (default) | none, or `&theme=tensorlake` | Dark, Tensorlake-inspired |
| paper | `&theme=paper` | The original sketch-based theme from the plan |
| scenic | `&theme=scenic` | Cobalt on cream, with an engraved landscape |

### tensorlake (default)

A dark theme modeled on the
[Tensorlake brand](https://www.inspora.design/posts/tensorlake-brand): warm near-black,
hairline panels, mint and emerald accents, deep-teal header bars, uppercase mono labels with
■ bullets, mint corner brackets on the hub, a faint canvas grid, and Geist / Geist Mono (OFL).

It lives in [`src/styles/theme-tensorlake.css`](src/styles/theme-tensorlake.css) as overrides
of the paper tokens in `tokens.css` under `:root[data-theme="tensorlake"]`, plus a few `atoi-*`
hook classes on labels, panel headers, the hub, avatars and primary buttons. Contrast is
noted at the top of that file; every text pair passes AA.

This follows another company's visual identity closely. Before it ships anywhere public we
should make it our own (accent color, ornaments, name).

### paper

The plan's original visual system (section 11): warm paper, ink lines, one steel-blue
accent, IBM Plex. Its tokens are the base in [`src/styles/tokens.css`](src/styles/tokens.css).

### scenic (cobalt on cream)

A cobalt-on-cream "engraving" look based on the
[scenic footer reference](https://www.inspora.design/posts/scenic-footer-section): cream paper,
cobalt and navy ink, small-caps labels, double-rule frames on the hub and header bars, Geist
Sans for the interface (code stays in mono), and avatars rendered as cobalt/cream duotones.

The reference's illustration isn't reused. [`ScenicBackdrop`](src/canvas/ScenicBackdrop.tsx)
draws an original engraved coastal landscape (hatched mountains, a lined sea, a headland
with cypresses and a bell tower, a sailboat) behind the lower half of the canvas. Styles are
in [`src/styles/theme-scenic.css`](src/styles/theme-scenic.css); every text pair passes AA.

## Avatars

Agents get human avatars so the team reads as people. The pool of 16 lives in
`src/assets/avatars/` and is committed. Each run deals faces from it at random, seeded by
run and agent ID, so an agent keeps its face across the card, chat and details, and no two
agents in a run share one until the pool runs out. To regenerate or resize the pool:

```bash
pnpm avatars --count 16 --salt atoi
```

Artwork: [Notionists](https://heyzoish.gumroad.com/l/notionists) by Zoish (CC0 1.0), rendered
with [DiceBear](https://www.dicebear.com/) (MIT). DiceBear is a dev dependency only.

## Sources

| URL | What it shows |
| --- | --- |
| `?source=mock&fixture=happy-path` | A scripted fixture streamed like a live run (also `recovery`, `third-worker`, `edge-states`). `&speed=2` plays it faster. A picker in the top bar switches fixtures; reload to restart. |
| `?source=live` | The newest run from `GET /api/runs`, replayed from authenticated event pages |
| `?source=live&run=r_8f2` | A specific run |

In mock mode, messages you send get a scripted reply that says it's scripted.

### Local API integration demo

From the repo root, in separate terminals:

```bash
pnpm demo:dashboard
pnpm dev:dashboard
```

Use the demo token printed by the first command. This starts the real API and a
throwaway MongoDB replica set with simulated orchestration and replies. Launch,
message, refresh to replay, then stop the run. The UI labels the simulation. No
Temporal worker, cloud sandbox, real model or Git execution runs in this mode.

## Backend contract

Vite proxies `/api` to `/operator` on `VITE_API_TARGET`. All requests carry the
operator Bearer token; no token is put in URLs or bundled environment variables.
Production hosting needs an equivalent HTTPS reverse proxy. `vite preview` alone
does not provide a production API proxy.

| Endpoint through proxy | Purpose |
| --- | --- |
| `GET /api/runs` | Canonical run array, newest first |
| `POST /api/runs` | Objective, repositoryUrl, workerLimit, lifetimeSeconds and stable requestId |
| `GET /api/runs/:runId/dashboard-events?after=N` | `{ events, cursor, hasMore }`, replayed/polled from persisted Atlas events |
| `POST /api/runs/:runId/messages` | `{ requestId, body, recipientId?, mentions: [] }`, returns persisted message |
| `POST /api/runs/:runId/stop` | Begin cleanup; terminal state waits for confirmation |

The cursor advances over raw event sequence numbers, including events not displayed
by the dashboard. The adapter never infers successful tests or pushes from model prose.
Task evidence is labeled agent-reported, and task commit references remain distinct
from recorded pushes. The CLI can inspect complete raw tool results. Custom model
endpoints report token usage but display **unpriced** for unknown dollar costs.

Operator DMs create deliveries and wake the addressed agent; plain team posts are
readable without waking everyone. Agents can reply to `operator`; the UI displays
that participant as `you`. Recorded request IDs replace optimistic message bubbles.
Use fresh runs after upgrading: older histories may lack task/message snapshots.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Layout

```
src/contract/events.ts   event types + zod schemas + the send-message request
src/state/               reduce.ts (pure fold), runStore.ts, chat.ts, selectors.ts
src/sources/             authenticated live source, in-browser mock source, mockRun
src/canvas/              geometry, nodes, edges, activity engine + layer
src/chat/                chat panel and composer
src/ui/avatars.ts        avatar pool + per-run assignment
src/inspector/           details drawer: summary, tasks, git, agent detail
fixtures/                TypeScript fixture builder and the four fixtures
scripts/generate-avatars.ts  regenerates src/assets/avatars
tests/                   vitest
```

## Where this differs from the plan

Product changes:

- No replay, scrubber or event feed. The dashboard always shows the newest state, and the
  chat is the log. Mock fixtures stream in at roughly real pace (gaps capped at 1.2 s).
- The right column is the chat, not the inspector. Summary, tasks, git and agent detail moved
  to a drawer over the canvas, and the canvas refits into the space beside it.
- You can message the orchestrator from the browser (the plan had this out of scope).
- Events that arrive more than 15 s after they happened (the backlog when you connect
  mid-run) update state without animating.

Implementation details:

- A peer link's control point starts at the plan's 0.25 × length push, then grows until the
  curve clears the hub. The plan's rule alone routes links between opposite slots through it.
- The canvas fits to the cards, the you node and the peer links that exist, rather than to
  nodes alone, so links that curve below the cards aren't cut off.
- While "sandbox sb-9d4 (was sb-2c3)" is showing, the strip drops the state word and keeps
  the dot, because both don't fit in a 240 px card.
- `--muted` text inside `--hub` rows uses `--ink` instead, since `--muted` on `--hub` is 4.4:1.
- The default theme is now the dark Tensorlake-inspired one; the plan's paper theme is
  `?theme=paper`.
- The hand-drawn reference sketch (`mesh-sketch.png`) wasn't in the repo.

## Not done yet

- Dedicated layout checks at 1280×720 and 1920×1080; launch/message/replay/stop were checked in Chrome at its current viewport.
- Reduced motion is unit-tested only; it wasn't checked in a browser with the setting on.
