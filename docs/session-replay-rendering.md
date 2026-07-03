# Session Replay — How a Recording Renders in the Player

This doc explains the full path from "user did something on Frameo" to "we
replay it in the dashboard." It is the read-side companion to
[session-replay-architecture.md](./session-replay-architecture.md) (write path)
and [session-replay.md](./session-replay.md).

## The one-line mental model

**rrweb does not record video or screenshots.** It records the DOM as JSON —
one full snapshot plus a stream of diffs — and the player *rebuilds the real
DOM inside an iframe* and re-applies the diffs frame by frame. The "video" you
watch is a live DOM being mutated by the recorded mutations.

---

## What is recorded (write side)

The SDK runs `rrweb.record()` in the user's tab. rrweb emits events; the SDK
batches them into chunks and POSTs them to `/track` as
`{ type: 'replay', payload: { session_id, window_id, chunk_index, payload, ... } }`.
`payload` is a JSON string: an array of rrweb events.

The event types that matter for rendering:

| rrweb type | Name | What it is |
|---|---|---|
| `2` | **FullSnapshot** | A complete serialized copy of the DOM tree at a moment. Every element has a unique numeric `id`. |
| `3` | **IncrementalSnapshot** | A *diff* referencing nodes by `id`: text changed, attribute/style changed, node added/removed, mouse moved, scroll, input, etc. |
| `4` | **Meta** | Page URL (`href`) + recorded viewport `width`/`height`. |
| `0/1/5/6` | Meta/Load/Custom/Plugin | Bookkeeping. |

Example FullSnapshot (trimmed):
```json
{ "type": 2, "data": { "node": { "type": 0, "childNodes": [
  { "type": 2, "tagName": "html", "attributes": { "lang": "en" },
    "childNodes": [ /* every element, each with an "id" */ ], "id": 2 }
]}}, "timestamp": 1782996106968 }
```

Example IncrementalSnapshot (a diff against the last FullSnapshot's ids):
```json
{ "type": 3, "data": {
  "source": 0,
  "texts": [{ "id": 411, "value": "120" }],
  "attributes": [{ "id": 1452, "attributes": { "style": { "height": "28px" } } }]
}, "timestamp": 1782996107121 }
```

---

## How it renders (read side)

### 1. Fetch chunks

Dashboard session page → `ReplayShell`
([apps/start/src/components/sessions/replay/index.tsx](../apps/start/src/components/sessions/replay/index.tsx)).

- `session.replayWindows` → lists the distinct recorders (tabs) that wrote to
  this session, keyed by `window_id`. Drives the "Recorded across N tabs"
  selector.
- `session.replayChunksFrom` (+ `windowId`) → pages the selected window's
  chunks. `session.replayMeta` gives the definitive duration.
- Each chunk's `payload` string is `JSON.parse`d into an array of rrweb events.

### 2. Construct the player

`ReplayPlayer`
([apps/start/src/components/sessions/replay/replay-player.tsx](../apps/start/src/components/sessions/replay/replay-player.tsx))
dynamically imports `rrweb-player` and does:

```ts
new rrwebPlayer({
  target: containerDiv,
  props: {
    events,                       // the parsed rrweb events
    width, height,                // from the Meta event's recorded viewport
    autoPlay: false,
    showController: false,        // we render our own controls
    speedOption: [0.5, 1, 2, 4, 8],
    UNSAFE_replayCanvas: true,    // replay <canvas> pixels (Frameo canvas)
    skipInactive: true,           // fast-forward idle gaps (toggleable in UI)
  },
});
```

`rrweb-player` creates a sandboxed **`<iframe>`** inside `containerDiv`.

### 3. Rebuild + apply (the actual "playback")

- **On the FullSnapshot:** rrweb calls `rebuild()` — it walks the serialized
  node tree and creates *real DOM nodes* (`<html>`, `<div>`, `<span>`…) inside
  the iframe. It also builds a **mirror table**: `Map<nodeId, realDomElement>`.
- **As the playhead advances:** each IncrementalSnapshot is applied by looking
  its target up in the mirror. `{ id: 411, value: "120" }` becomes
  `mirror.getNode(411).textContent = "120"`. Style diffs mutate `.style`, adds/
  removes insert/detach nodes, mouse events move a cursor overlay.
- The iframe is scaled with CSS `transform` to fit the dashboard layout; the
  recorded viewport aspect ratio comes from the Meta event.

So playback = **rebuild the DOM once from the snapshot, then poke it with the
recorded diffs in timestamp order.**

---

## Why things look the way they do

### "Node with id 'X' not found" (the multi-recorder / mixed-mirror bug)

The mirror table is rebuilt on each FullSnapshot. If chunks from **two
recorders** are fed to one player:

- Recorder A's FullSnapshot builds the mirror with ids 1–5000.
- Recorder B's incremental says "mutate node 14012".
- 14012 isn't in the mirror → `Node with id '14012' not found`.

**Fix:** `window_id`. One tab / page-load = one `window_id` = one recorder =
one consistent mirror. The player plays a single window at a time
(`replayChunksFrom({ windowId })`), so mirrors never mix. The session page's
window selector lets the user pick which tab's recording to watch. See
[[project-replay-bugs]] and the migration in
`packages/db/code-migrations/20-add-window-id-to-replay-chunks.ts`.

### Frozen / "white" stretches on the timeline

During a period with **no recorded events** (the user was idle, or a tab was
backgrounded), there is nothing to apply — the DOM sits frozen while the clock
ticks. A mostly-idle recording (e.g. a forgotten tab with a stray event every
25 min) looks like minutes of a frozen frame.

**Fix:** `skipInactive: true` (default, with a "Skip idle" toggle in the player
header). rrweb fast-forwards through inactive periods so a 169-minute-but-mostly-
idle recording plays through in its few seconds of real activity. Toggle it off
to watch idle time literally.

### High FullSnapshot ratio / large chunks

Frameo's canvas DOM is heavy, and rrweb takes a fresh FullSnapshot every
`checkoutEveryNms` (10s) when active — so FullSnapshots dominate and chunks are
large (hundreds of KB each). That's expected for a canvas-heavy app; it inflates
storage but does not affect correctness.

---

## Component map (read side)

| File | Role |
|---|---|
| `sessions/replay/index.tsx` | `ReplayShell` (window selector) → `ReplayContent` (fetches chunks, owns skip-idle toggle) → wires everything |
| `sessions/replay/replay-player.tsx` | Constructs rrweb-player, rebuilds DOM in iframe, wires rrweb event listeners |
| `sessions/replay/replay-context.tsx` | Playback state (play/pause/seek/duration), chunk buffer, smart-seek fetchers |
| `sessions/replay/replay-chunk-buffer.ts` | Tracks which chunk indices/ranges are loaded (buffered-bar + seek) |
| `sessions/replay/replay-timeline.tsx` | The scrubber + event markers |
| `packages/db/.../session.service.ts` | `getSessionWindows`, `getReplayList`, `getSessionReplayChunksFrom/AroundTime/ByIndexRange` (all accept `windowId`) |
| `packages/trpc/.../session.ts` | tRPC procedures: `replayWindows`, `replayList`, `replayChunksFrom`, `replayChunksAroundTime`, `replayChunksByIndexRange`, `replayMeta` |

## Where recordings are surfaced in the UI

- **Session Replays** (top-level nav, `/replays`) — one row per session that has
  a recording, newest first, with a "N tabs" badge for multi-window sessions.
- **Session detail** (`/sessions/$sessionId`) — inline player with the window
  selector ("Recorded across N tabs") and the Skip-idle toggle.
- **Session list** — a small video icon (`hasReplay`) on rows that have a
  recording.
