# atoi dashboard

A live view of one atoi run: a mesh canvas of agents around shared state, a Slack-style chat
that is the main way to read what the team is doing, and a direct line from you to the
orchestrator. It started from [`atoi-dashboard-plan.md`](../atoi-dashboard-plan.md); the
product changes since then are listed below.

**Status: mock data only.** Nothing here talks to the real backend yet. The UI runs on
scripted fixtures in the browser and on a local fake backend (`fake-sse`). A run working
here does not show that the backend, Atlas, Modal or Temporal integration works.

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
| `VITE_API_TARGET` | `http://localhost:8787` | Where the dev server proxies `/api` |
| `VITE_DEFAULT_SOURCE` | `mock` | Source used when the URL has no `?source=` |

## Using it

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
| `?source=live` | The newest run from `GET /api/runs`, streamed over SSE |
| `?source=live&run=r_8f2` | A specific run |

In mock mode, messages you send get a scripted reply that says it's scripted.

### Fake backend

`fake-sse` serves a fixture through the same endpoints the real backend will implement, so
the live path (EventSource, reconnects, `Last-Event-ID`, sending messages) can be tested:

```bash
pnpm fake-sse --fixture happy-path --speed 4 --drop-after 30
```

Then open `http://localhost:5173/?source=live`. `--drop-after N` closes each connection
after N events to test reconnects. The server marks its run `mock: true`, so the dashboard
shows the mock strip.

## Backend contract

[`src/contract/events.ts`](src/contract/events.ts) holds the event types and zod schemas,
with no React or app imports so the backend can copy it. Endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/runs` | `{ runs: { id, objective, status, startedAt, mock? }[] }`, newest first |
| `GET /api/runs/:runId/events` | SSE: every event after `Last-Event-ID` / `?after=`, then new ones |
| `POST /api/runs/:runId/messages` | **New.** Body `{ to, body, clientRequestId }`, returns `202 { messageId }` |

Additions to the original plan's contract:

- `USER_ID = "user"` names the operator. It can appear in `from`/`to` of `message.sent` for
  the DM with the orchestrator. It is not an agent and gets no inbox.
- `message.sent` has an optional `clientRequestId`, echoing the id from the POST, so the
  dashboard can match its "sending…" bubble to the recorded message. Retrying with the same
  id must not create a duplicate.
- After a POST, the backend records `message.sent` from `user` plus a `delivery.queued` for
  the orchestrator, and wakes it like any DM.

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
src/sources/             live SSE source, in-browser mock source, mockRun (shared with fake-sse)
src/canvas/              geometry, nodes, edges, activity engine + layer
src/chat/                chat panel and composer
src/ui/avatars.ts        avatar pool + per-run assignment
src/inspector/           details drawer: summary, tasks, git, agent detail
fixtures/                TypeScript fixture builder and the four fixtures
scripts/fake-sse.ts      local mock backend
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

- Connecting to the real backend, including its implementation of the messages endpoint.
- Screenshots at 1280×720 and 1920×1080 for review. Playwright isn't installed; layouts were
  checked by hand in a browser.
- Reduced motion is unit-tested only; it wasn't checked in a browser with the setting on.
