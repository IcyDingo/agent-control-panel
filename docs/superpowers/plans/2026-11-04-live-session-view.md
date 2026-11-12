# Live Session View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The open session's Chat shows every text block, tool call and result as it lands in the transcript, within ~100 ms, with hook events marking tool state at once; the board redraws once per burst.

**Architecture:** A pure line parser (`history.mjs`) turns transcript lines into thread items. A tailer (`follow.mjs`) watches one transcript by byte offset and feeds the parser. A per-session thread model (`thread.mjs`) merges parsed items with hook events, order-independently, and emits new items and updates. `server.mjs` wires follows to SSE clients and sends `thread` events; the page keeps a keyed row list per session and patches rows in place.

**Tech Stack:** Node 20 (ESM, `node:fs`, `node:test`), vanilla browser JS in one HTML file, SSE. No dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-live-session-view-design.md`

## Global Constraints

- Node 20, no dependencies, macOS (`fs.watch` on a single file is available).
- Transcripts reach hundreds of MB: never re-read a file on change; read only appended bytes; parse only whole lines.
- One follow per transcript however many pages have it open; a follow is released when no connected page has the session open, after the server's existing `RECONNECT_MS` grace.
- `public/index.html` stays one file with inline script and style.
- Tests run with `npm test` (`node --test`), no browser.
- Nothing about deciding, messaging, modes or profiles changes behaviour.
- Thinking blocks are parsed to nothing and not shown. No fake typing animation.

## Review Focus

Inputs the spec implies but the tasks' tests do not all cover; each has a pinning test added to its owning task below.

1. A transcript line longer than one read (a 6 MB tool result written in two `write()`s): the follow must hold the partial line and emit the item once, when the newline arrives. (Task 2)
2. A `tool_result` whose `tool_use` was before the backfill window: it renders as its own row, not dropped and not merged into a wrong row. (Task 1, Task 3)
3. A permission request settled while no page is open (expired, panel closed): the row's final state is recorded so a page that opens later sees it. (Task 3)
4. A profile switch while a follow is open: the follow is dropped and the page re-follows under the new profile without a stale `thread` event arriving for the old one. (Task 4)
5. Two pages (the app window and a browser tab) following the same session: one watcher, both receive items; closing one keeps the other fed. (Task 4)

---

### Task 1: Per-block thread items from transcript lines

**Files:**
- Modify: `history.mjs`
- Modify: `test/history.test.mjs`
- Modify: `server.mjs:686-691` (`history()` passes `before`)

**Interfaces:**
- Produces: `itemOf(line: string, pos: number): Item | null`, `chatOf(lines: string[], pos0?: number): Item[]` (pos of each line computed from `pos0` + byte lengths), `readChat(file, { limit = 60, before = Infinity, chunk }): Promise<{ items: Item[], more: boolean }>` where `limit` counts turns (a turn starts at a `you` item) and `before` keeps only items with `pos < before`.
- Item shapes (every item has `at: number` (ms) and `pos: number` (byte offset of its line) and `key: string`):
  - `{ who: 'you', key: 'you:<pos>', text }`
  - `{ who: 'claude', key: 'claude:<pos>', text, messageId }` — one per text block
  - `{ who: 'tool', key: 'tool:<tool_use.id>', toolUseId, name, summary: { tool, text }, input, state: 'running' }`
  - `{ who: 'result', key: 'result:<pos>', toolUseId, ok: boolean, preview: string, at }`
  - `{ who: 'note', key: 'note:<pos>', text }`
- `summary.text` is the first 240 chars of the same pick order as `server.mjs` `summarize()`; move that pick into `history.mjs` as `export function summaryOf(tool, input)` and have `server.mjs` `summarize()` call it (so `at` stays server-side).
- `preview`: for a string result, its first 6 lines or 600 chars, whichever is shorter, plus `… (N more lines)` when cut; for a content array, the text blocks joined the same way; `ok` is `!is_error`.

- [ ] **Step 1: Rewrite `test/history.test.mjs` expectations to per-block items**

Keep the existing fixture lines. Change the test "one reply written in several blocks reads as one" to "one reply written in several blocks is one item per block, sharing messageId" asserting two `claude` items with equal `messageId` and increasing `pos`. Add tests:

```js
test('a tool call and its result are separate items linked by toolUseId', () => { /* tool_use line then user tool_result line → [tool{state:'running'}, result{ok:true, preview}] */ });
test('a result whose call is not in the lines is still an item', () => { /* only the tool_result line → one result item */ });
test('thinking, api-request and sidechain lines yield nothing', () => { /* itemOf → null for each */ });
test('a long result is cut to six lines with a count', () => { /* 40-line stdout → preview ends with '… (34 more lines)' */ });
test('pos is the byte offset of the line, not its index', () => { /* chatOf(lines, 1000) with a multibyte first line → second item pos = 1000 + Buffer.byteLength(line0) + 1 */ });
test('readChat limits by turns and honours before', async () => { /* temp file with 3 turns; limit 2 → items from the last 2 you-items on; before = pos of last you → nothing from the last turn */ });
```

- [ ] **Step 2: Run the tests; expect the new and changed ones to fail**

Run: `npm test -- test/history.test.mjs`
Expected: FAIL on the new assertions (`itemOf` undefined, items joined).

- [ ] **Step 3: Implement `itemOf`, `summaryOf`, and make `chatOf`/`readChat` use them**

`chatOf` keeps the duplicate-`you` suppression (same text within 2 s) and compaction note. `readChat` threads `pos` through its back-from-the-end loop: the chunk's start offset is the `pos0` for the lines it yields; stop when the turns counted reach `limit`. Drop the text-only filter in `talk()` so `tool_use` and `tool_result` lines pass; keep it refusing `api-request*` and lines starting with `{"type":`-only metadata as now.

- [ ] **Step 4: Point `server.mjs` `summarize()` at `summaryOf` and pass `before` from `history()`**

`history(body)` reads `body.before` (integer or absent) into `readChat`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all pass (the `profiles`, `restart` tests still read `summarize()` output unchanged).

- [ ] **Step 6: Commit**

```bash
git add history.mjs test/history.test.mjs server.mjs
git commit -m "Thread items per block: tool calls, results and text blocks from the transcript"
```

---

### Task 2: Following a transcript by byte offset

**Files:**
- Create: `follow.mjs`
- Create: `test/follow.test.mjs`

**Interfaces:**
- Consumes: `itemOf(line, pos)` from Task 1.
- Produces: `createFollow(file: string, { onItems: (items: Item[]) => void, onReset: () => void, pollMs = 1000 }): { start(): Promise<void>, stop(): void, offset(): number }`.
  - `start()` stats the file, sets the offset to its size, and begins watching (`fs.watch(file)`) plus a `pollMs` `stat` fallback.
  - On change: read `[offset, size)`, append to a carry `Buffer`, split on `\n`, parse each complete line with `itemOf(line, lineStartPos)`, keep the incomplete tail as carry, advance the offset, call `onItems` once with every item of this read (skip the call when none).
  - Size smaller than the offset, or `stat().ino` changed: clear carry, set offset to 0, call `onReset()`, then read from 0.
  - `stop()` closes the watcher and clears the timer; a change after `stop()` does nothing.

- [ ] **Step 1: Write `test/follow.test.mjs`**

Each test makes a temp file, a follow with `pollMs: 50`, collects `onItems` calls, and uses an `until()` helper (as `test/daemon-server.test.mjs` does) with a 3 s bound.

```js
test('an appended line is one item with the offset where it began', ...);        // write header; start; append one assistant text line → items.length 1, items[0].pos === initialSize
test('a line split across two writes is parsed once, when its newline arrives', ...); // write first half (no \n), wait 200 ms → no call; write rest + '\n' → one item
test('three lines in one write are one onItems call with three items', ...);
test('a truncated file resets and reads from the start', ...);                   // append, then fs.truncateSync(file, 0), write a line → onReset once, items from pos 0
test('a replaced file (new inode) resets', ...);                                 // rename a new file over it
test('stop() ends it: a later append is not seen', ...);
```

- [ ] **Step 2: Run; expect failure (module missing)**

Run: `npm test -- test/follow.test.mjs`

- [ ] **Step 3: Implement `follow.mjs`**

Reads use `fs.promises.open` + `read` at the offset, serialised (a read in progress defers the next change to one more read after it). Line start positions: `offset + bytesBeforeThisLineInCarry`.

- [ ] **Step 4: Run; expect pass. Commit**

```bash
git add follow.mjs test/follow.test.mjs
git commit -m "follow.mjs: tail a transcript by byte offset, whole lines only"
```

---

### Task 3: The server-side thread model

**Files:**
- Create: `thread.mjs`
- Create: `test/thread.test.mjs`

**Interfaces:**
- Consumes: Item shapes from Task 1.
- Produces: `createThread({ emit: (events: ThreadEvent[]) => void }): Thread` with
  - `addItems(items: Item[])` — from backfill or follow. A `result` item whose `toolUseId` matches a known `tool` row becomes an `update` of that row (`state` from `ok` → `'done' | 'failed'` unless a hook already set `'refused'`, `preview`, `endedAt: at`) and is not kept as its own row; one with no known row is kept as a `result` row.
  - `hook(e)` — a hook event (`e.hook_event_name`, `e.tool_name`, `e.tool_input`, `e.tool_use_id?`, `e.agent_id`). Ignores events with `agent_id`. `PreToolUse` → row `running` (creating a provisional `tool` row with `key = toolKey(e)` when none exists; `pos: null`); `PostToolUse` → `done`; `PostToolUseFailure` → `failed`; `PermissionDenied` → `refused`; `Stop` → appends `{ who: 'turn', key: 'turn:<Date.now()>', at }`.
  - `request(e, { waiting: true })` / `request(e, { why })` — a held permission request started or settled: the row gets `waiting: true` or `waiting: false, settledWhy: why`.
  - `toolKey(e)`: `'tool:' + e.tool_use_id` when `e.tool_use_id` is a string, else `'tool~' + e.tool_name + ':' + JSON.stringify(e.tool_input ?? {})`. A transcript `tool` row whose `name`+`input` JSON equal a provisional `tool~` row's adopts it: the provisional row is removed (an `update` with `removed: true`) and its state carried over.
  - `items(): Item[]` — the current rows, oldest first, for a page that follows later.
  - `reset()` — forget rows (not hook state).
  - Hook state survives `reset()` and is kept for the last 300 keys per thread, so a backfill added after the hooks ran gets annotated (`addItems` applies remembered state to matching rows).
  - `ThreadEvent` is `Item` (new row) or `{ who: 'update', key, patch: object }`.
  - Emission is coalesced: all events from one synchronous call go out in one `emit([...])`.

- [ ] **Step 1: Write `test/thread.test.mjs`**

```js
test('line then hook: the tool row is created by the line and set done by PostToolUse', ...);
test('hook then line: PreToolUse makes a provisional row; the tool_use line adopts it under the real key', ...); // emits removed:true for the provisional key, and a tool row with state 'running'
test('a result before its call becomes a result row; a result after its call is an update', ...);
test('a refused call stays refused when its tool_result arrives', ...);
test('a held request marks waiting, and settling records why', ...);
test('Stop appends a turn divider', ...);
test('hook state remembered before the backfill annotates the backfill', ...); // hook() done for id X, then addItems([tool X]) → row state 'done'
test('the same inputs in either order give the same rows', ...);              // feed a fixed script forwards and permuted; items() deepEqual
test('events of one call are emitted once, together', ...);
```

- [ ] **Step 2: Run; expect failure. Step 3: Implement `thread.mjs`. Step 4: Run; expect pass.**

- [ ] **Step 5: Commit**

```bash
git add thread.mjs test/thread.test.mjs
git commit -m "thread.mjs: merge transcript items with hook state, order-independently"
```

---

### Task 4: Server wiring: follows, SSE thread events, coalesced broadcasts

**Files:**
- Modify: `server.mjs` (hook handler ~184-272, `holdPermission`/`settle` ~371-400, `broadcast` ~1410-1422, `/events` ~1478-1500, `ACTIONS` ~1522, `switchProfile` ~1287, `listen` tail)
- Create: `test/live-server.test.mjs`

**Interfaces:**
- Consumes: `createFollow`, `createThread`, `readChat`.
- Produces (HTTP/SSE contract the page relies on):
  - `GET /events?t=<token>&c=<client>`: `c` is a page-minted id (UUID). Unnamed `data:` messages stay the snapshot. Named events: `event: thread` with `data: { sessionId, events: ThreadEvent[] }`; `event: thread-reset` with `data: { sessionId }`.
  - `POST /api/follow { client, sessionId | null, limit = 60 }` → `{ ok: true, items, more }`: records that `client` has `sessionId` open (one per client; `null` clears). Ensures a follow for that transcript exists: opens the follow first (offset at current size), then backfills with `readChat(file, { limit, before: offset })`, feeds the backfill into the session's thread, and returns `thread.items()` and `more`. For a session with no transcript yet, returns `{ ok: true, items: [], more: false, pending: true }` and retries opening every second until the file exists, then sends the backfill as `thread` events.
  - `POST /api/history { sessionId, limit, before }` stays for "Show earlier" (returns raw items with `pos < before`; the page prepends them).
  - Snapshot gains `events: [...]` (every `broadcast(event)` argument since the last snapshot) and drops `event`.
  - `broadcast()` coalesces at 30 ms.
- Server state: `threads: Map<sessionId, Thread>` (created on first hook or follow); `follows: Map<sessionId, { follow, clients: Set<clientId> }>`; `clientOpen: Map<clientId, sessionId>`; `clientRes: Map<clientId, res>`.
- Every hook event for a session on the shown profile calls `threads.get(id)?.hook(e)` (create the thread when the event is `PreToolUse` so provisional rows and remembered state exist). `holdPermission` calls `thread.request(e, { waiting: true })`; `settle` calls `thread.request(p, { why })` using the pending record's `toolName`/`toolInput`/`toolUseId` (store `e.tool_use_id` on the pending record).
- Thread emits go to every client in `follows.get(sessionId).clients` as `thread` events.
- A client's stream closing removes it from every follow; a follow with no clients stops after `RECONNECT_MS`. `switchProfile` stops all follows, clears `clientOpen`, and sends `thread-reset` for each previously followed session.

- [ ] **Step 1: Write `test/live-server.test.mjs`** (spawn a real server as `test/daemon-server.test.mjs` does, with `ACP_PREFS` and a temp `CLAUDE_CONFIG_DIR` holding `projects/<slug>/<id>.jsonl`)

```js
test('follow returns the backfill and later lines arrive as thread events within 300 ms', ...);
test('two clients following one session share one watcher and both receive items; one closing keeps the other fed', ...);
test('a PreToolUse hook POSTed to /hook/event reaches the thread as an update', ...);
test('a follow for a session with no transcript yet turns live when the file appears', ...);
test('many broadcasts in one tick give one snapshot whose events list has them all', ...); // post two hook events back-to-back; read one SSE message with events.length >= 2
test('a profile switch drops the follow: thread-reset arrives, and a line appended to the old transcript afterwards sends nothing', ...);
```

- [ ] **Step 2: Run; expect failure. Step 3: Implement the wiring in `server.mjs`.**

Send named SSE events with `res.write(`event: thread\ndata: ${json}\n\n`)`. Keep `clients` as the set of `res` for snapshots.

- [ ] **Step 4: Run the full suite; expect pass. Commit**

```bash
git add server.mjs test/live-server.test.mjs
git commit -m "Server: follow the open session's transcript and stream thread events; coalesce snapshots at 30 ms"
```

---

### Task 5: Page: a keyed, live thread

**Files:**
- Modify: `public/index.html` (connect ~726-760, chat ~1195-1300, `doReply` ~1388-1419, styles near `.msg`)

**Interfaces:**
- Consumes: the SSE/HTTP contract of Task 4; Item/ThreadEvent shapes of Tasks 1 and 3.
- Produces (page internals, named so later tasks and reviewers can find them): `CLIENT` (UUID minted at load), `threads: Map<sessionId, { rows: Map<key, Item>, more, pending }>`, `followOpen(sessionId)`, `applyThread(sessionId, events)`, `renderThread(s)` (keeps its name; now a keyed reconciler), `earlier()`.

- [ ] **Step 1: Connection and follow**

`connect()` opens `/events?t=…&c=CLIENT`; `es.addEventListener('thread', …)` → `applyThread`; `'thread-reset'` → drop the thread and `followOpen` again. Whenever `open` changes (in `render()`, compare to a `followed` variable) call `followOpen(open)` which POSTs `/api/follow { client: CLIENT, sessionId: open }` and seeds `threads` from the reply; on reconnect (`es.onopen` after a drop) call it again. Remove `chatKey` and `loadChat`'s timer-driven reloads; `chats` is replaced by `threads`.

- [ ] **Step 2: Snapshot events list**

Replace `const ev = snap.event; if (ev?.type === 'settled' …)` with a loop over `snap.events ?? []`.

- [ ] **Step 3: Keyed reconciler in `renderThread`**

Rows are built from `threads.get(s.sessionId).rows` plus the local items (`outbox`, `queued`, `sent`) with keys `local:<at>`. For each row in order: reuse the element stored on `row.el` when its `_sig` (JSON of the fields that render) is unchanged, rebuild that one element otherwise; append/insert to keep order; remove elements whose key is gone. Adjacent `claude` rows with the same `messageId` share one `.msg.claude` wrapper (the first row owns the wrapper; later ones append a `.m-body`). Keep the latest 400 rows in the DOM unless the user has scrolled up or pressed "Show earlier".

- [ ] **Step 4: Tool rows**

`who: 'tool'` → `div.msg.tool[data-state]` with: a state glyph (`running` pulses with the existing `--run` colour; `done` `--ok`; `failed`/`refused` `--stop`; `waiting` `--amber`), `summary.tool` in `b`, `summary.text` in mono, duration `((endedAt ?? now) - at)` as `1.2 s`/`45 s`/`2 m` when done, and a `details` disclosure holding `pre.m-body` with `preview` when present. `who: 'result'` (orphan) → the same row without a name, titled "Result". `who: 'turn'` → `hr.turn`. `settledWhy` shows as the row's small note using the existing `SETTLED` map.

- [ ] **Step 5: Sending state and follow-the-bottom**

`outbox` rows show as now ("Sending…"/"Sent"); when a `you` row with the same `norm(text)` arrives in the thread within 10 s, drop the outbox entry. Replace `stick`/`followEnd` logic with: measure `atBottom = scrollHeight - scrollTop - clientHeight < 48` before applying rows; after, if `atBottom` was true scroll to bottom. `keepBelow` stays for "Show earlier". Add a small "↓ newer" button (`#d-newer`) shown when rows arrived while not at bottom; clicking scrolls down and hides it.

- [ ] **Step 6: Show earlier**

`$('d-earlier').onclick` → `earlier()`: `POST /api/history { sessionId, limit: 100, before: minPos }` where `minPos` is the smallest `pos` among rows; prepend the items (results merge into tool rows client-side with the same rule as `thread.mjs`: a result for a known row is an update), set `more` from the reply.

- [ ] **Step 7: Styles**

Add `.msg.tool`, `.msg.tool .glyph`, `[data-state]` colours, `.turn`, `#d-newer`, within the file's existing tokens (hairlines, 8 px radius, `--mono`). Running glyph animation respects `prefers-reduced-motion` (the file already disables animations under it).

- [ ] **Step 8: Verify by hand**

Run: `ACP_PORT=4790 ACP_PREFS=/tmp/acp-live/prefs.json node server.mjs`, open `http://127.0.0.1:4790/`, open a running session and run a few tools in it from its terminal. Expected: each tool appears as a running row within a blink, turns done with a duration, and Claude's text appears block by block; `grep -c "CONSOLE" ` of a headless-Chrome `--enable-logging=stderr` load is 0.

- [ ] **Step 9: Commit**

```bash
git add public/index.html
git commit -m "Page: live keyed thread with tool rows, sending state and follow-the-bottom"
```

---

### Task 6: README and cleanup

**Files:**
- Modify: `README.md` ("Messaging a session", first paragraph)
- Modify: `server.mjs` (remove `lastMessage` fallback in snapshot only if the page no longer uses `s.lastMessage`; otherwise leave)

- [ ] **Step 1: Rewrite the Chat paragraph**

Replace "the conversation so far, read from its transcript … **Show earlier** reads further back" with: the Chat follows the session's transcript as it is written: what you typed, each piece Claude writes, every tool it calls with its state and how long it took, and a short look at what the tool returned; a new line is on screen within a fraction of a second; **Show earlier** reads further back. State that thinking and full tool output stay in the terminal.

- [ ] **Step 2: Run the suite and the hand check from Task 5 once more. Commit**

```bash
git add README.md server.mjs
git commit -m "README: the Chat is live"
```
