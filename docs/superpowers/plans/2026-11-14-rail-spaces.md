# Spaces in the rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named spaces in the rail, inside a workspace, that the owner puts agents into by hand.

**Architecture:** The workspace store (`workspaces.mjs`, `workspaces.json`) gains per-workspace spaces and session
membership. The server exposes them in each workspace's snapshot only, adds `/api/space/*` actions sealed to the page's
workspace, applies a space chosen at launch once the session appears, and carries it over on continuation. The page
draws space sections after Needs you and offers a Space picker in New agent and in a session's details.

**Tech Stack:** Node standard library (server), one `public/index.html` (no build), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-14-rail-spaces-design.md`

## Global Constraints

- A space is not a workspace: workspaces stay one per Claude login, unchanged.
- Only a click by the owner moves an agent between sections.
- A space's name, or which agents it holds, never reaches a page or notification of another workspace.
- Space names: 1–40 characters, trimmed, unique in the workspace ignoring case.
- Node standard library only; the page stays one file with no build step; existing tests keep passing.
- Nothing in the rail changes for anyone who never makes a space.

## Review Focus

1. Launching into a space that was deleted meanwhile (another page) → the launch is refused with "That space is gone. Pick another." and nothing starts. (Task 2 test.)
2. Moving a session of another workspace, or into a space id of another workspace → refused with the seal's error; nothing changes. (Task 2 test.)
3. A name that is blank, all spaces, 41 characters, or a case-variant of an existing one → refused with the store's error; renaming a space to a case-variant of its own name is allowed. (Task 1 test.)
4. A `workspaces.json` whose `spaces` part is malformed → workspaces and repositories load as before, spaces start empty. (Task 1 test.)
5. A space name with markup (`<b>x</b>`) → shown as text in rail, picker and details (the page builds nodes with `el(..., { text })`, never `innerHTML`). (Task 3/4: use `text:` only; checked in Task 5's run.)

---

### Task 1: Spaces in the workspace store

**Files:**
- Modify: `workspaces.mjs` (state `st`, load, returned API)
- Test: `test/workspaces.test.mjs`

**Interfaces:**
- Produces (on the object `createStore()` returns; `ws` is a workspace id the store knows, else `{ ok: false, error: 'No such workspace.' }`):
  - `spacesOf(ws) → Array<{ id: string, name: string }>` in creation order; `[]` for an unknown ws.
  - `createSpace(ws, name) → { ok: true, id } | { ok: false, error }`; id is `randomUUID().slice(0, 8)`.
  - `renameSpace(ws, id, name) → { ok } | { ok: false, error }`; unknown id → `'No such space.'`.
  - `deleteSpace(ws, id) → { ok } | { ok: false, error }`; drops its members too.
  - `spaceOf(ws, sessionId) → string | null`.
  - `setSpace(ws, sessionId, id | null) → { ok } | { ok: false, error }`; `null` removes membership; unknown id → `'No such space.'`.
  - `touchSpaces(ws, liveIds: string[], now = Date.now()) → void`: stamps members in `liveIds` (`at = now`, only when the stamp is over an hour old, so it doesn't write every tick) and drops members whose `at` is older than 14 days; saves only on change.
- Kept in `st.spaces[ws] = { list: [{ id, name }], members: { [sessionId]: { space, at } } }`, saved in the same 0600 file; `v` stays 1.
- Name errors (exact): `'A space needs a name.'`, `'A name is at most 40 characters.'`, `'Another space has that name.'`.

- [ ] **Step 1: Write the failing tests** in `test/workspaces.test.mjs`:
  - `test('spaces are made, renamed and deleted per workspace')`: create "Checkout redesign" in `default` → `ok`, `spacesOf('default')` deep-equals `[{ id, name: 'Checkout redesign' }]`, `spacesOf('contract')` is `[]`; rename to "Checkout" → listed name changes; delete → `[]`.
  - `test('a space name is checked')`: `createSpace('default', '   ')` error `'A space needs a name.'`; 41 × "a" → `'A name is at most 40 characters.'`; create "Billing", then "billing" → `'Another space has that name.'`; but `renameSpace(ws, id, 'BILLING')` on its own id → ok; the same name in `contract` → ok; `createSpace('nope', 'x')` → `'No such workspace.'`.
  - `test('sessions are put in a space and taken out')`: `setSpace('default', SID, id)` → `spaceOf` is `id`; `setSpace(..., null)` → `null`; unknown id → `'No such space.'`; deleting the space clears `spaceOf` for its members.
  - `test('spaces survive a restart, and a malformed spaces part is ignored')`: make a space and a member, new `createStore` on the same file → both there. Then write the file with `spaces: 'nope'` (and once with `spaces: { default: { list: [{ id: 1 }] } }`) → `list()` still has both workspaces, `spacesOf('default')` is `[]`.
  - `test('members not seen for 14 days are dropped')`: member stamped at `t0` via `touchSpaces('default', [SID], t0)`; `touchSpaces('default', [], t0 + 13 * DAY)` keeps it; `touchSpaces('default', [], t0 + 15 * DAY)` drops it (`spaceOf` → `null`); the space itself stays.

- [ ] **Step 2: Run to verify they fail**

Run: `node --no-warnings=ExperimentalWarning --test test/workspaces.test.mjs`
Expected: the five new tests FAIL (`s.createSpace is not a function`).

- [ ] **Step 3: Implement the store additions** in `workspaces.mjs`, validating the loaded `spaces` part entry by entry (string ids and names, known workspace, member `space` naming a listed id) and dropping anything else, with `Object.create(null)` maps as the rest of the store uses. Name check mirrors `update()` (trim, max, case-insensitive uniqueness, excluding the space being renamed).

- [ ] **Step 4: Run to verify they pass**

Run: `node --no-warnings=ExperimentalWarning --test test/workspaces.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit** — `feat(spaces): the workspace store keeps each workspace's spaces and who is in them`

---

### Task 2: The server: snapshot, actions, launch and continuation

**Files:**
- Modify: `server.mjs` — `snapshot(wsId)` (~3093), the `ACTIONS` map (~3305), `launch()` (~653), `reply()` copy branch (~1250), `continueInOpenCode()` (~3093), `remove()` (~802)
- Create: `test/spaces-server.test.mjs` (harness copied from `test/workspaces-server.test.mjs`: two profiles, stand-in `claude`, `watch()`, `api()`, `until()`, `ACP_GITHUB: 'off'`)

**Interfaces:**
- Consumes: Task 1's store API.
- Produces:
  - Snapshot: top-level `spaces: Array<{ id, name }>` (the page's workspace only) and each session's `space: string | null`.
  - `POST /api/space/create { name } → { ok, id }`, `/api/space/rename { id, name } → { ok }`, `/api/space/delete { id } → { ok }`, `/api/space/move { sessionId, space: id | null } → { ok }`; all act on `ctx.focus`; a session of another workspace is already refused by the seal (`ownedBy`); a space id not in `ctx.focus` → `'No such space.'`. Each success calls `broadcast()`.
  - `/api/launch` accepts `space: id | null`. Unknown id → `{ ok: false, error: 'That space is gone. Pick another.' }` before anything runs. On success the server keeps `pendingSpace: Map<launchId, { ws, space, at }>` (launchId is `r.id`) and a helper `claimSpaces(wsId)`, called from `snapshot()`, assigns any session of that workspace with no space whose `sessionId === k || sessionId.startsWith(k) || s.id === k`, then forgets the entry. Entries older than 10 minutes are dropped.
  - Continuation: in `reply()`'s copy branch, `pendingSpace.set(id, { ws, space: spaceOf(old) })` when the old one has a space; in `continueInOpenCode()`, `store.setSpace(ws, r.sessionId, spaceOf(old))`. The old session keeps its space.
  - `remove()`: a removed session's membership is dropped (`setSpace(ws, id, null)`).
  - `touchSpaces(wsId, live session ids)` runs from the roster poll for each workspace (not from every snapshot).

- [ ] **Step 1: Write the failing tests** in `test/spaces-server.test.mjs`:
  - `test('a space made on one page shows only in its own workspace')`: A (default) creates "Billing bug" → `ok`; A's latest snapshot has `spaces` `[{ id, name: 'Billing bug' }]`; B's (contract) has `spaces: []` and `JSON.stringify(B.latest())` does not include `'Billing bug'`.
  - `test('moving a session puts it in the space, and None takes it out')`: A moves `SID_D` into the space → A's snapshot session `SID_D` has `space === id`; move with `space: null` → `null`.
  - `test('a page cannot move another workspace\'s session, or use its space')`: A moves `SID_C` → `ok: false`, error `REFUSE`; B creates "Contract work" (`idC`); A moves `SID_D` into `idC` → error `'No such space.'`; A renames/deletes `idC` → `'No such space.'`; B still lists "Contract work".
  - `test('a launch into a space lands there when the session appears')`: A creates "Launches"; launch in `work` with `space: id` (the stand-in returns `backgrounded · deadbeef`); write a roster entry for a session whose `sessionId` starts with `deadbeef` into `roster-default.json`; `until` A's snapshot shows that session with `space === id`.
  - `test('a launch into a deleted space is refused and nothing runs')`: create then delete a space; launch with its id → `ok: false`, error `'That space is gone. Pick another.'`; `logged()` has no new `--bg` call.
  - `test('deleting a space sends its sessions back')`: move `SID_D` in, delete the space → `SID_D` has `space === null`, `spaces` no longer lists it.

- [ ] **Step 2: Run to verify they fail**

Run: `node --no-warnings=ExperimentalWarning --test test/spaces-server.test.mjs`
Expected: FAIL (no `spaces` in the snapshot; `/api/space/create` 404 or not ok).

- [ ] **Step 3: Implement** the snapshot fields, the four actions (a function each, next to `assignRepo`), `space` in `launch()` (validate first, record after `ok`, for both the Claude and the OpenCode path), `claimSpaces`, the continuation and `remove()` hooks, and `touchSpaces` in the roster poll.

- [ ] **Step 4: Run to verify they pass, and that nothing else broke**

Run: `node --no-warnings=ExperimentalWarning --test test/spaces-server.test.mjs test/workspaces-server.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit** — `feat(spaces): spaces in each workspace's snapshot, actions to make and move them, kept through launch and continuation`

---

### Task 3: Space sections in the rail

**Files:**
- Modify: `public/index.html` — `sections()` (~1636), `sectionEl()` (~1621), `renderBoard()` (~1955), the fold store (`repoFoldKey`/`repoFolded`/`isFolded`/`toggleFold`, ~1590), `bulksOf()` (~1940), `HINT`, `tile()` (the `away` tag, ~1880), slim-rail CSS (~955)

**Interfaces:**
- Consumes: snapshot `spaces` and `session.space` (Task 2); `/api/space/rename`, `/api/space/delete`.
- Produces: section kind `'space'` with key `'space:' + id`; helper `spaceIn(s) → string | null` (the session's space if it is in `snap.spaces`, else `null`), used by Task 4.

- [ ] **Step 1: Sections** — `sections(g)` puts, right after Needs you, one section per `snap.spaces` entry (in its order) with `{ key: 'space:' + id, kind: 'space', space: id, title: name, list, asks }`. A busy or idle session with `spaceIn(s)` goes to its space's list instead of its repo/loose list; a waiting one stays under Needs you and adds to its space's `asks`. Sessions in a space are left out of the "repos" map, so a repo section whose sessions are all in spaces disappears (unless it has asks).
- [ ] **Step 2: Header and tools** — a space section folds like a repo (fold keys `space:*` kept in the same per-workspace store as `repo:*`: widen the `startsWith('repo:')` checks to `/^(repo|space):/`). Its title tooltip is empty, no `col-path`. Its tools are `bulksOf` (extend the kind check to `'space'`) plus a "Rename" button (replaces the title with an `input.field` holding the name: Enter saves via `/api/space/rename`, Escape or blur without change cancels, an error shows with `toast(r.error, true)`) and a Delete arm button with key `spacedel:<id>`, text "Delete", armed text "Delete?", running `/api/space/delete`; add `HINT.spacedel = 'Deletes the space. Its agents go back to their repositories.'`.
- [ ] **Step 3: Rows and empty state** — in `tile()`, the repository tag shows when `st === 'waiting' || spaceIn(s)`. A space with no rows (and no search) shows `c.empty` with "No agents right now". Slim CSS: `body.rail-slim .col[data-col="space"]:not(:has(.tile-wrap))` hidden; everything else the slim rail does for repo sections (hairline, folded-with-live rows) already applies by class.
- [ ] **Step 4: Check by hand** in the real app (Task 5's recipe): a space with one session, folded and unfolded, slim and wide; a repository whose only session moved into a space disappears; Rename and Delete work; `npm test` still passes.
- [ ] **Step 5: Commit** — `feat(spaces): space sections in the rail, after Needs you`

---

### Task 4: Choosing a space: New agent and a session's details

**Files:**
- Modify: `public/index.html` — launcher markup (~1164) and submit handler (~3694), `openLauncher()` (~3569), details `d-info` block (~2123)

**Interfaces:**
- Consumes: `spaceIn(s)` (Task 3); `/api/space/create`, `/api/space/move`, `/api/launch { space }` (Task 2).

- [ ] **Step 1: New agent** — a `label.lf` "Space" with `select.field#l-space`: "None" (value `''`), each space, and "New space…" (value `'+new'`), which reveals `input.field#l-space-new` (maxlength 40, placeholder "Name the space"). `openLauncher()` refills the options from `snap.spaces` and keeps the last choice if it still exists. On submit with `'+new'`: call `/api/space/create { name }` first; on error show it in `lErr` and stop; then launch with `space: newId`. Otherwise send `space: value || null`. The field always shows, even with no spaces yet: "New space…" is how the first one is made.
- [ ] **Step 2: Details** — in `d-info`, a row `dt` "Space" / `dd` holding `select.field` with "None", each space and "New space…"; changing it calls `/api/space/move { sessionId, space }` (for "New space…", an inline input like the launcher's, then create and move). Add `s.space` and `snap.spaces` to the block's `patch` signature. Not shown for a session with `s.mismatch`.
- [ ] **Step 3: Check by hand** in the real app: launch into a new space → the agent appears in it; move it to another space and back to None from details; the picker lists only this workspace's spaces.
- [ ] **Step 4: Commit** — `feat(spaces): pick a space in New agent, or move an agent from its details`

---

### Task 5: Docs and a run in the real app

**Files:**
- Modify: `README.md` (the rail section: one paragraph on spaces)

- [ ] **Step 1: README** — describe spaces in the rail section, in the README's voice: what they are, that they are not workspaces, how to make one, move an agent and delete one.
- [ ] **Step 2: Run the app** on a throwaway home with the stand-in `claude` and `gh` (as `test/workspaces-github.test.mjs` sets up, `ACP_PORT` spare), drive it with headless Chrome over CDP: make two spaces, launch into one, move a session, fold, slim, rename to `<b>x</b>` (shows as text), delete; switch workspace tab and see none of them. Screenshot and look.
- [ ] **Step 3: Full suite** — `npm test`: 0 failures.
- [ ] **Step 4: Commit** — `docs: spaces in the README`
