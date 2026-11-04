# Live session view

*Design, 2026-11-04. Status: reviewed by a builder check; calls marked "my call" are the author's, not the owner's.*

## Intent

Opening a session in the panel should feel like looking at its terminal. Everything the terminal shows as the
session works, the text Claude writes, each tool it calls and what came back, its questions and permission prompts,
appears in the panel's Chat within a fraction of a second of it happening, in order, without the page ever appearing
to wait for a timer. The board's tiles move at the same pace.

Today the Chat shows only the reply Claude ended each turn on, read from the transcript when a 15-second bucket rolls
over, and the board redraws on a 10-second snapshot plus whatever hook events happen to arrive. That reads as a
status page. The owner wants it to read as the terminal does: fluent.

## What the terminal has that we can have

Claude Code appends to a session's transcript (`~/.claude/projects/<slug>/<session id>.jsonl`) one line per event, as
it happens. Measured on a live session (2026-11-04): a thinking block, a text block and a tool call that belong to one
model message land as three separate `assistant` lines, milliseconds to seconds apart, each as soon as that block is
complete; a tool's result lands as a `user` line with a `tool_result` block when the tool finishes. The panel's hooks
add the moment a tool *starts* (`PreToolUse`), which the transcript only shows once the call is written.

What the terminal has that we cannot: the characters of a text block as they stream from the API. The transcript holds
a text block only once it is whole. So the unit of liveness is the block, not the token. A reply that is one long
paragraph appears at once when it is done; a reply made of several blocks interleaved with tool calls appears piece by
piece, which is most of what a working session looks like.

## Goals

1. **Everything in the thread, as it lands.** The Chat shows, oldest first: what you typed; each text block Claude
   wrote; each tool call as a row (what it is, in the panel's existing one-line summary, with its state: running, done,
   failed, refused, and how long it took); compaction notes; the moment a request waited on you and how it was answered.
   A new line in the transcript is on screen within about 100 ms on a Mac that is not under load.
2. **Push, never poll, for the open session.** The server watches the transcript file of the session that is open on
   the page and reads only the bytes appended since its last read. Nothing on the page asks on a timer for the thread.
3. **The board moves too.** Tile state, the tool a session is on, and the subagent rows update as the events arrive,
   coalesced so a burst of events is one redraw.
4. **Your own message shows at once.** Pressing Enter puts the message in the thread immediately as "sending", and it
   becomes a normal message when the transcript confirms it (today's return-to-the-box-on-failure stays).
5. **The thread stays readable.** Following the bottom while you have not scrolled up, keeping your place when you have,
   and never jumping under the pointer. Rows that arrive do not shift the row you are reading.

## Non-goals

- Token-level streaming of text. Not available from outside the process (see above). Do not emulate it with fake typing.
- Reproducing the terminal's widgets (spinners, progress bars, the input line). The panel keeps its own look.
- Changing how messages get into a session. The resume path and the terminal-session rules stay as they are.
- Showing a subagent's own thread. A subagent stays a row under its session with its current tool and its result, as
  now. Its transcript may be followed in a later iteration.
- Rendering tool *results* in full. A result row shows a short preview (the first lines, a count, an error's first
  line) and can be expanded to a capped amount; the full output stays in the terminal.
- Thinking blocks. They are not shown. (A later toggle may show them; the parser should keep them available.)

## Anti-goals

Things that would make this a failure even if it works:

- **CPU or disk churn.** Transcripts reach hundreds of megabytes. Re-reading a file, or parsing lines the page will
  never show, on every change is unacceptable. One session followed at a time, by byte offset, parsing only appended
  whole lines.
- **Flicker or reflow.** A redraw per event that rebuilds the thread's DOM, or a row that renders twice (once from the
  hook, once from the transcript) and jumps.
- **A panel that lies.** A tool shown as "running" that finished, or a message shown as sent that was not. Hook
  events and transcript lines describe the same things; one must win, and the design below says which.
- **Breaking what works.** Decisions, messaging, modes, profiles and the board's behaviour are unchanged by this.

## Constraints

- Node 20, no dependencies, macOS. `fs.watch` on a single file works on macOS and is enough; a 1-second stat
  fallback covers a watcher that goes quiet (a transcript replaced by a new file after compaction, say).
- One server, one or more pages (the Mac app's window and a browser tab, say). The page says which session it has
  open; the server follows the union of the sessions the connected pages have open, each at most once.
- The page is a single HTML file with inline script, as now. Keep it so.
- Tests run with `node --test`, no browser. Parsing and tailing must be testable with fixture lines and a temp file
  that grows.

## Design

### Server: following a transcript

A new module, `follow.mjs`, owns one followed transcript:

- `open(file, { fromEnd })`: records the current size as the offset. For a session the page just opened, the backfill
  comes from `readChat` (extended, below) and following starts at the end; the two are stitched by the page using the
  line's position in the file (every item carries `pos`, the byte offset of its line), so an item is never shown twice.
- On change (`fs.watch` and a 1 s `stat` fallback): read from the offset to the end, split on newline, keep an
  incomplete trailing line in a carry buffer for the next read, parse each whole line with the shared parser, and emit
  the items it yields.
- A file that shrinks or whose inode changes is reopened from the start of its new content, with a `reset` item so the
  page reloads the thread.
- `close()` stops the watcher. The server closes a follow when no connected page has that session open any more, with
  a short grace period (the `RECONNECT_MS` the server already uses for pages) so a reload does not thrash.

### Shared parser: lines to thread items

`history.mjs` grows from "the reply Claude ended on" to the full thread, and both `readChat` (backfill) and
`follow.mjs` (live) use the same function, so the thread looks identical whether it was read back or watched in.

One line yields zero or one item:

| transcript line | item |
|---|---|
| `user` with text (not meta, not a tool result) | `{ who: 'you', text, at, pos }` |
| `attachment` `queued_command` (prompt mode) | the same `you` item |
| `assistant` text block (not sidechain, not synthetic) | `{ who: 'claude', text, at, pos, messageId }`, one item per block |
| `assistant` `tool_use` block | `{ who: 'tool', id: tool_use.id, name, summary, input, at, pos, state: 'running' }` |
| `user` `tool_result` block | `{ who: 'result', toolUseId, ok, preview, at, pos }` |
| `user` with `isCompactSummary` | `{ who: 'note', text: SUMMARY, at, pos }` |
| `assistant` thinking block, `api-request*`, `mode`, titles, sidechain lines | nothing |

**One item per block (my call).** A text block is one item; the page shows adjacent `claude` items with the same
`messageId` as one bubble. Today's `chatOf` joins the blocks of a message with blank lines and a test asserts that; the
test changes to assert the per-block items and the page's grouping takes over the joining. This keeps the parser a
pure line-to-item function with no cross-line carry, which is what a live append needs.

`summary` reuses the server's `summarize(tool, input)` so a tool reads the same in the thread, on the tile and in a
permission card. The page merges a `result` into its `tool` row by `toolUseId` (the row's state becomes done or failed,
with duration from the two timestamps); a result whose call it never saw (backfill cut) renders as its own row.

`readChat` keeps its read-from-the-end-in-chunks shape and its `limit`, but counts turns, not items, so "Show
earlier" still means "earlier turns". It threads the byte offset through its chunk loop so every item carries `pos`.
Today's text-only mode goes; the Chat always shows the full thread.

### Hooks and the transcript: who wins

**The server owns the thread (my call).** For each followed session the server keeps the thread model in memory: the
items parsed from the transcript, with the state the hooks add to them. Hook events update that model; the page only
renders what it is sent. This keeps the merge rule in one testable place, keeps the page dumb, and means a session
opened mid-turn shows the same rows as one watched from the start (the server has been receiving its hooks all along,
whether or not a page was open; it keeps the hook state for the last few hundred tool calls per session so a follow
started later can annotate the backfill).

Transcript lines are authoritative for *what* happened; hooks are authoritative for *state* until the transcript
confirms it. Order is not guaranteed either way: the `tool_use` line is usually written before `PreToolUse` fires
(the block is complete before the tool runs), but a hook can arrive first. The merge is keyed and order-independent:

- A tool row is keyed by `tool_use_id` (the transcript's `tool_use.id`; the hook's `tool_use_id` when it carries one),
  falling back to `(tool_name, JSON of input)` for a hook without an id. Whichever side arrives first creates the row;
  the other fills it in.
- `PreToolUse` sets `running`. `PostToolUse` sets `done`, `PostToolUseFailure` sets `failed`, `PermissionDenied` sets
  `refused`, each at once; the `tool_result` line confirms (or, for a row the hooks never touched, decides) the state
  and supplies the preview and the duration.
- A permission request the panel holds marks its tool row `waiting` while it is pending, and the row records how it was
  settled (the `why` the server already computes). The request card itself stays where it is today.
- `Stop` closes the turn: the server emits a `turn` item the page shows as a thin divider.

Thread items are therefore not append-only: an `update` carries a row key and the fields that changed, and the page
patches that row. Nothing in this changes how the server decides anything; it only annotates what the page shows.

### Transport

The existing SSE stream carries two more event kinds beside the snapshot:

- `thread`: `{ sessionId, items: [...] }`, new items and `update`s for a followed session, sent as they happen,
  coalesced over about 30 ms so one tool call and its text block arrive as one message.
- `thread-reset`: `{ sessionId }`, the file changed underneath; the page reloads that thread.

Snapshots already coalesce: today `broadcast()` sends once, 80 ms after the first call in a window, and drops the rest.
That stays, tightened to about 30 ms. What changes is the single `lastEvent` slot the snapshot carries, which a later
event in the same window overwrites: it becomes a list of the events since the last snapshot, so two requests settled
in one burst both reach the page. The 10 s periodic broadcast stays as the heartbeat that moves "x minutes ago" labels.

The page tells the server what it has open with `POST /api/follow { client, sessionId | null }` on open and close, and
again on reconnect. `client` is an id the page mints at load and also sends on `/events`, so the server can tie a follow
to a stream and release it when the stream closes. A follow for a session whose transcript does not exist yet (just
launched) retries until it appears; a profile switch drops every follow and the pages re-open theirs.

### Page

- The Chat renders the thread as a flat list of rows: you, Claude, tool (with inline state and duration), note, turn
  divider. Rows are keyed; a small reconciler appends new rows, patches a row whose data changed and removes none
  (today's `patch` helper rebuilds its whole container on any change, so it is not enough here). No rebuild on snapshot.
- Tool rows: one line, the panel's summary, a state glyph, duration when done, and a disclosure that shows the result
  preview (capped) when there is one. Failed and refused rows are tinted with the existing stop colour.
- Follow-the-bottom: if the last row was within one row-height of the viewport bottom before the append, scroll to the
  bottom after it; otherwise leave the scroll alone and show the existing "newer messages" affordance if there is one,
  or add a small one.
- Your sent message: appended at Enter with a sending state; the first `you` item from the transcript with the same
  text within a few seconds replaces it (dedupe by text, as `chatOf` already does for doubles). On failure it is removed
  and the text returns to the box, as today.
- The DOM keeps the latest 400 rows; "Show earlier" prepends and the cap is lifted while you read back.
- The tile's "last tool" and subagent rows already update from hooks; with coalesced broadcasts they visibly keep up.

### Testing

- `history.test.mjs`: fixture lines for every row in the table above, interleaving, a text block split across lines
  of one message, a result arriving before its call in a backfill window, compaction.
- `follow.test.mjs`: a temp file appended to in pieces, including a line split across two writes, a write with three
  lines, truncation, replacement; assert the items and the offsets, and that nothing is parsed twice.
- Thread model: hook before line, line before hook, result for an unseen call, a held request settled each way; the
  same rows come out whichever order the inputs arrive in.
- Server test (the existing spawn-a-real-server style): open a follow, append to the transcript file, receive the
  `thread` event over SSE within a bound; close the page, see the watcher released.
- Coalescing: many `broadcast()` calls in one tick produce one snapshot that carries every event of the burst.

## What the builder decides

- The 30 ms coalescing windows and the 400-row cap are starting values; tune by feel, keep them in one place.
- How the result preview is cut (first N lines, N characters, a count line for long outputs) and what "expanded" is
  capped at.
- The exact look of the tool row, the turn divider and the sending state, within the panel's existing style
  (hairlines, 8 px radii, the state colours already defined).
- Whether `follow.mjs` uses `fs.watch` with a `stat` fallback or a short `stat` interval alone, as long as the measured
  latency on an appended line is under 100 ms and an idle follow costs nothing visible.
- Where the "newer messages" affordance sits.

## Out of scope, noted for later

- A toggle to show thinking blocks.
- Following a subagent's own transcript when its row is opened.
- Showing the terminal's own input line and queued messages.
