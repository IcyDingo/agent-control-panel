# Home as a board: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Home's "Main agents" and "Waiting on you" sections with a head line of counts, one "Needs you" block acted on in place, and a grid of space and repository cards.

**Architecture:** The deciding logic (who needs the owner and why, which card an agent is on, the counts, which replies "Send all" may send) goes in a new file `public/home-board.js`. It has no imports or exports and sets `globalThis.HomeBoard`, so the page loads it as a plain script and Node tests import it. `public/index.html` draws from it with its existing `el()` / `patch()` helpers and reuses the side panel's and the agent view's functions for every action. The server serves the one new file.

**Tech Stack:** Plain JavaScript in one HTML page, Node's built-in test runner (`npm test`).

**Spec:** `docs/superpowers/specs/2026-11-24-home-board-design.md`

## Global Constraints
- No new server routes or server data, beyond serving `public/home-board.js` (the page is otherwise built from `snap.spaces`, `snap.sessions`, `snap.pending`, `snap.overseer.follow`, each session's `gh`, `snap.mains`).
- No change to the side panel, the agent view, Ask Glue's chat, the heatmap, or the main agent.
- Nothing runs without a click; Merge and "Send N replies" take two clicks (`confirmOr` / armed state, as merges do today).
- Card order: spaces in the order they were made (`snap.spaces`), empty ones included; then one card per repository by name; then "Other folders". Never reordered by state.
- One meaning of "needs you": waiting (`stateOf(s) === 'waiting'`), or a follow-up, or failed and not dismissed, or a green PR (`mergeable(s.gh?.pr)`). Priority when several apply: waiting > follow-up > failed > ready to merge.
- Deleting a space is not on Home.
- Both themes; one column on a narrow window.

## Review Focus
1. A reply being typed in a Needs-you row must survive every snapshot redraw (Home redraws on each one): keep using `fuEdits`, and never rebuild a row's textarea when only other rows changed.
2. An agent whose space was deleted (`spaceIn(s)` null) goes on its repository's card, not nowhere. Test in Task 1.
3. OpenCode requests and "open" requests (`p.open`) never get inline Allow/Deny; they get "Answer". Test in Task 1 (`plainAsk`).
4. Many spaces and agents: a card shows at most 6 live rows; redraws go through signatures, so a snapshot that changes one agent rebuilds one card.
5. A narrow window: the Needs-you row's buttons wrap under its text; cards fall to one column.

---

### Task 1: Home's logic, served and tested

**Files:**
- Create: `public/home-board.js`
- Create: `test/home-board.test.mjs`
- Modify: `server.mjs` (the `VENDOR` serving block near "What the page loads besides itself")

**Interfaces:**
- Produces, on `globalThis.HomeBoard`:
  - `needsList({ sessions, stateOf, reqsOf, asking, follow, mergeable, dismissed })` → `[{ s, kind, follow, reqs }]`. `kind` is `'waiting' | 'follow' | 'failed' | 'merge'`. `asking` is the side panel's ordered array of session ids with requests. `follow` is `snap.overseer.follow` (items have a short `sessionId`, matched by `s.sessionId.startsWith(f.sessionId)`). `mergeable(s)` → boolean. `dismissed(s)` → boolean. Order: waiting (ids in `asking` order first, then the other waiting ones by `startedAt` descending), follow (in `follow` order), failed, merge. Each session at most once, at its highest-priority kind.
  - `needKinds(list)` → `Map<sessionId, kind>`.
  - `homeCards({ spaces, sessions, spaceIn, repoOf, mainOf, colOf, stateOf, kinds })` → `[{ key, kind, id, title, main, live, finished, prs }]`. `kind` is `'space' | 'repo' | 'loose'`. `key` is `space:<id>`, `repo:<path>` or `loose`. `main` is the main agent's session or null. `live` holds the space's non-main sessions whose `colOf` is not finished, or that have a kind in `kinds`, sorted with kinds first (in priority order), then busy, then idle. `finished` is the count of the rest. `prs` is `{ failing, running, ready }` over `s.gh?.pr`. Repository and loose cards exist only while they have a session; space cards always exist.
  - `headCounts({ sessions, kinds, colOf, stateOf, mergeable })` → `{ need, working, idle, ready }`, with no overlap between `need`, `working` and `idle`.
  - `plainAsk(reqs)` → boolean: exactly one request, not `p.open`, not `p.agent === 'opencode'`, and `p.toolName` is in `['Bash','Read','Glob','Grep','WebFetch','WebSearch']` or starts with `mcp__`.
  - `bulkReplies(rows, restarts)` → `{ send, left }` over the `kind === 'follow'` rows. `restarts(row)` → true when sending would close a terminal Claude; those rows go in `left`.
  - `dismissKey(s)` → `` `${s.sessionId}:${s.state}:${s.lastMessageAt ?? ''}` ``. A dismissal holds while this key is unchanged.

- [ ] **Step 1: Write the failing tests** in `test/home-board.test.mjs`. Load the file with `await import('../public/home-board.js')`, then use `globalThis.HomeBoard`. Use small session fixtures `{ sessionId, state, startedAt, space, repo, gh }`, with `stateOf = (s) => s.state` and `colOf` mapping failed and finished to `'finished'`.
  - `needsList orders waiting (asking first), then follow-ups, failed, ready PRs; each agent once at its top kind`: a session that is waiting and has a follow-up appears once, as `waiting`; a failed session with a follow-up appears as `follow`; a session with a green PR and nothing else appears as `merge`; a dismissed failed one does not appear.
  - `homeCards keeps spaces in their order, empty ones too, then repositories by name, then Other folders`: assert keys `['space:b','space:a','repo:/r/alpha','repo:/r/zeta','loose']` for spaces given as `[b, a]`.
  - `an agent whose space is gone is on its repository's card`: `spaceIn` returns null for it, so it lands in `repo:/r/alpha`.
  - `a card lists needs-you first, then working, then idle; finished are a count; the main agent is not a row`.
  - `a repository card stays while it has only finished agents, and goes when it has none`.
  - `headCounts do not overlap`: a waiting agent counts in `need` only; a busy agent with a green PR counts in `need` (its kind is `merge`), and `ready` counts it too.
  - `plainAsk`: true for one Bash request; false for Edit, for two requests, for `open: true`, and for `agent: 'opencode'`.
  - `bulkReplies leaves out replies that would close a terminal Claude`.
  - `dismissKey changes when the agent says something new`.

- [ ] **Step 2: Run the tests to make sure they fail**
  Run: `node --no-warnings=ExperimentalWarning --test test/home-board.test.mjs`
  Expected: FAIL (cannot find module `public/home-board.js`).

- [ ] **Step 3: Implement `public/home-board.js`** with the interfaces above. It has no `import` or `export`: it ends `globalThis.HomeBoard = { needsList, needKinds, homeCards, headCounts, plainAsk, bulkReplies, dismissKey };`.

- [ ] **Step 4: Serve it.** In `server.mjs`, add `'/home-board.js': 'text/javascript; charset=utf-8'` to the served allow-list. Read it from `./public/home-board.js` with `cache-control: no-cache` (it changes with Glue, unlike the vendored files). Add a test to `test/home-board.test.mjs`, or to an existing server test that already starts the server (`test/live-server.test.mjs`): `GET /home-board.js` returns 200 with a JavaScript content type, and `GET /home-board.js.map` returns 404.

- [ ] **Step 5: Run the tests to make sure they pass**
  Run: `node --no-warnings=ExperimentalWarning --test test/home-board.test.mjs test/live-server.test.mjs`
  Expected: PASS.

- [ ] **Step 6: Commit**: `feat(home): the board's logic in public/home-board.js, served and tested`

### Task 2: The head line and the space cards

**Files:**
- Modify: `public/index.html`. Add `<script src="/home-board.js"></script>` before the main inline script (line ~1533). Replace `renderMains`, `maCard` and `agentsLine` (the "main agents: a card per space" block) with `renderCards`. Replace the `h-mains` section with `<section class="h-cards-all" id="h-spaces" aria-label="Spaces">`, placed after `h-board`. Add the head counts to `h-meta`'s line. Add CSS next to the `.ma-*` rules, which go.

**Interfaces:**
- Consumes: `HomeBoard.homeCards`, `HomeBoard.headCounts`, `HomeBoard.needKinds` (Task 1). From the page: `visible()`, `spaceIn`, `stateOf`, `colOf`, `mainOfSpace`, `bulksOf`, `watchSpace`, `quickLaunch`, `confirmOr`, `armed`, `lineOf`, `label`, `glyph`, `ago`, `snap.mains`, `/api/main/wake`.
- Produces: `renderCards(kinds)`; `homeKinds()` → the `Map` from `needKinds(needsList(...))`, computed once per `renderHome`, used by Tasks 2 and 3; `NEED_WORD = { waiting: 'asks you', follow: 'reply drafted', failed: 'failed', merge: 'PR ready' }`.

- [ ] **Step 1: The head line.** In `renderHome`, after `h-meta`, show `"<need> need you · <working> working · <idle> idle · <ready> PRs ready"`, leaving out the parts that are 0, with "need you" in amber. It is text in its own `<span id="h-counts">`.

- [ ] **Step 2: `renderCards(kinds)`** draws one card per `homeCards` entry, in order. Each card gets a signature so it is rebuilt only when its own data changes.
  - **Head:** the title (a repository card: the repository's short name and a quiet "no space"), the + and the ⋯.
    - The +: `quickLaunch(key)` for a space. For a repository: `openLauncher({ space: '', cwd: repo, where: tilde(repo) })`, the same call `quickLaunch` makes for a repository section.
    - The ⋯: Turn on/off main agent (the same conditions as the side panel's menu), Rename for a space (sets `renaming` and opens the space's section in the side panel, as the side panel's Rename does), and the `bulksOf` buttons for the card's sessions. Build a section-like object `{ key, kind, space, list }` for `bulksOf`, leaving out the "delete" entry.
  - **Summary:** `"<n> agents: …"` in the format `spaceSummary` uses, but counting kinds as "needs you" (amber), plus `" · +<finished> finished"`. A PR line only when `prs` has any non-zero count: `"PRs: 1 failing · 2 ready"`.
  - **Main agent block** when `main` is set: `"Main agent, " + (resting ? 'watching' : state word)`, the start of its report (`reportStart`, already in the page), opening it on click, and the wake/carry-on line moved from `maCard`.
  - **Rows:** at most 6 of `live`, each a button opening the agent (`cancelAdvance(); open = id; render();`). A row shows its glyph, `label(s)`, and as detail either `NEED_WORD[kind]` or the side panel's `lineOf(s)` first part, or "idle <age>". When the agent has a PR, add `#<n>` coloured by its checks. "+<k> more" unfolds the rest of that card only, kept in a page-level `Set` of unfolded card keys.
  - **Empty space:** "No agents yet".

- [ ] **Step 3: Check it in a second Glue.** Run `ACP_PORT=4790 ACP_PREFS=<job tmp>/glue-try/prefs.json ACP_GITHUB=off node server.mjs`. Its data folder already has auto-fix and alerts off. Screenshot Home with a space that has agents and one empty space, plus a repository card. Expected: cards in space order and then repositories, the head line counts, and no console errors (check `Runtime.exceptionThrown` in the screenshot script).

- [ ] **Step 4: Run all tests.** Run `npm test`. Expected: 0 fail.

- [ ] **Step 5: Commit**: `feat(home): a card per space and repository, and a line of counts`

### Task 3: Needs you, acted on in place

**Files:**
- Modify: `public/index.html`. Replace `renderWaiting` and `fuCard`'s card layout with `renderNeeds(list)`, whose rows reuse `fuAct`, `fuMerge`, `fuEdits`, `fuSure`, `fuBusy` and `howWords`. Rename the `h-board` heading to "Needs you". Add CSS.

**Interfaces:**
- Consumes: `HomeBoard.needsList`, `HomeBoard.plainAsk`, `HomeBoard.bulkReplies`, `HomeBoard.dismissKey` (Task 1); `homeKinds()` (Task 2); from the page: `reqsOf`, `asking`, `askText`, `buildCard(p)`, `api('/api/decide', { id, behavior })`, `fuAct`, `fuMerge`, `mergeable`, `confirmOr`, `pref`.
- Produces: `renderNeeds(list)`; `dismissedNeeds`, a `Set` of `dismissKey` values loaded from and saved to `pref('acp.homeDismissed')` as JSON, keeping only keys of sessions still on the board.

- [ ] **Step 1: The rows.** One row per `needsList` entry: glyph, `label(s)`, its space's or repository's name, then by kind:
  - **waiting with `plainAsk(reqs)`:** `askText(reqs[0])`, then Allow (`/api/decide { id, behavior: 'allow' }`) and Deny (`{ id, behavior: 'deny' }`). An error shows under the row.
  - **waiting otherwise, with requests:** `askText(reqs[0])` (plus " +n"), and "Answer", which toggles `buildCard(reqs[0])` unfolded under the row. Cache the card by request id, so a redraw keeps what was typed in it.
  - **waiting with no requests:** `lineOf(s)` and Open.
  - **follow:** what `fuCard` shows today (the ask or what is left, the PR state, the reply box with `fuEdits`, Send / Keep going / Merge #n, the terminal-restart warning), laid out as a row. Same handlers.
  - **failed:** its last line, Open, and Dismiss (adds `dismissKey(s)` to `dismissedNeeds` and redraws).
  - **merge:** `"PR #<n> ready"` and Merge #n (`confirmOr('merge:' + sessionId, …)`). It calls the merge the same way `fuMerge` does, given the session instead of a follow-up. Refactor `fuMerge(f, pr)` into `mergeSession(sessionId, pr)` used by both.
  - The name opens the agent. "Nothing needs you." when the list is empty.

- [ ] **Step 2: Send N replies.** At the block's head, `bulkReplies(followRows, (r) => r.follow.how === 'restart' && r.s.kind === 'interactive')`, shown when `send.length >= 2`. The first click arms it: `"Confirm: send <n> replies"`, plus `" · <k> left out: it would close Claude in its terminal"` when `left.length`. The second click calls `fuAct(f, 'send', rowButton, text)` for each, in order, with the text from `fuEdits` or the drafted reply.

- [ ] **Step 3: Check it in the second Glue.** Inject in the page only (as before: change `snap` locally and call `render()`) one pending Bash request, one Edit request, one follow-up with a green PR, a follow-up marked restart on an interactive session, a failed agent, and an agent with a green PR. Screenshot. Click Dismiss and Answer. Arm Send all without confirming it. Expected: Allow/Deny on the Bash row only; Answer unfolds the Edit card; the armed label names the one left out; Dismiss removes the failed row. Nothing is sent to a real agent (the injected sessions are fake, and Send all is never confirmed).

- [ ] **Step 4: Run all tests.** Run `npm test`. Expected: 0 fail.

- [ ] **Step 5: Commit**: `feat(home): Needs you, acted on in place, with Send all`

### Task 4: Finish

- [ ] **Step 1:** Remove what no longer has a caller: `.ma-*` and `.h-mains` CSS, `renderMains`, `maCard`, `renderWaiting`, and the old `fuCard` layout if fully replaced. Check with `grep`. Check that the page's script still parses (extract the inline scripts and run `node --check`).
- [ ] **Step 2:** Update the spec's "What goes" with anything removed beyond it. Mark the design doc's status as built.
- [ ] **Step 3:** `npm test`, push, open the PR, and merge when CI is green, as the owner's standing rule says.
