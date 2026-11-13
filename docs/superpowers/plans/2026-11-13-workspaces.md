# Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Glue's one-profile-at-a-time board into sealed workspaces: each keeps working all the time, and the page shows one workspace with only a count from the others.

**Architecture:** Workspaces are one-to-one with Claude Code profiles, and the profile id is the workspace id (`default`
for `~/.claude`, `contract` for `~/.claude-contract`). Session ids are unique across profiles, so the existing global
maps keyed by session id stay as they are. Every session record gains `ws`, and everything per-login moves from the
global `profile`/`childEnv`/`configDir` into one record per workspace. The page's focus is per client. The server
builds a snapshot **for a workspace**, holding that workspace's data plus `{id, name, color, waiting}` for the others,
and refuses actions on anything outside the client's focus. The overseer becomes one instance per workspace. The
watcher and the GitHub poller stay single, and they route and filter by workspace.

**Tech Stack:** Node 20+ ES modules with no dependencies, `node:test`; a single-file page (`public/index.html`); Swift
app untouched.

**Spec:** `docs/superpowers/specs/2026-11-13-workspaces-design.md`

## Global Constraints

- Nothing from an inactive workspace leaves the server except `{ id, name, color, waiting }`. That includes session
  ids, names, folders, repository names, branches, PR titles, transcript text and feed lines.
- Every action that targets a session, request or proposal checks it belongs to the requesting client's focused
  workspace. The refusal reads: `That belongs to another workspace. Switch to it to do this.`
- Every process Glue starts for a session runs with **that session's workspace's** environment (`CLAUDE_CONFIG_DIR`),
  never a global one.
- With exactly one workspace, the page looks and behaves as today: no switch, no accent, no folder questions.
- Keys ⌃1…⌃9 select workspaces in order and never fire while typing in a text field.
- Default colours: the plain profile is `violet` (`#a98af0`) and others take `blue` (`#7ea6e6`), then `green`
  (`#55b985`), `teal` (`#5bb8c4`), then `rose` (`#e07a9a`). Amber is never a workspace colour.
- The count (`waiting`) is held requests, plus open questions and plans, plus that workspace's overseer cards
  waiting for a click.
- Copy for inactive-workspace notifications is exactly `<Name>: <n> needs you` / `<Name>: a check failed`.
- Server-side files stay `0600` (as `overseer.json` and `watcher.json` are today).
- The `ACP_*` environment variables, the hook URLs and the port are unchanged.

## Review Focus

1. **A hook event arriving for a profile that has no workspace yet** (a profile folder created after start). Expect
   it to become a workspace on the next roster tick, not to be dropped or shown in the focused one. Pinned in Task 2.
2. **Two pages focused on different workspaces at once** (the app and a browser tab). Expect each to get its own
   snapshot, and an action from one never to land in the other. Pinned in Task 3.
3. **A repository in Both, with sessions from both workspaces on the same branch.** Expect the PR watcher to ask
   once in total, not once per workspace. Pinned in Task 5.
4. **`workspaces.json` missing, empty or corrupt.** Expect the defaults from the profiles, no crash, and a rewrite on
   the next change. Pinned in Task 1.
5. **Switching while a message is unsent, and switching back.** Expect the confirm as today, and the other
   workspace's draft to still be there afterwards, since drafts are per session and stay in the page. Pinned in
   Task 9.

---

### Task 1: The workspace store (`workspaces.mjs`)

**Files:**
- Create: `workspaces.mjs`
- Test: `test/workspaces.test.mjs`

**Interfaces:**
- Produces:
  - `COLORS: Record<'blue'|'violet'|'green'|'teal'|'rose', string>`
  - `repoKey({ slug, common, dir }): string` returns `gh:<owner/name>` when there is a slug, else `git:<common>`, else
    `dir:<dir>`
  - `createStore({ file, profiles }): Store`, where `profiles` is `[{ id, dir, plain }]` as from `listProfiles()`
  - `Store.list(): Array<{ id, name, color, order }>`, in `order`
  - `Store.get(id): { id, name, color } | null`
  - `Store.update(id, { name?, color? }): { ok: boolean, error?: string }`. Names are 1–24 characters, unique, and
    case-insensitive.
  - `Store.reposOf(key): string[]` returns the workspace ids a repository is in (`[]` when unsorted)
  - `Store.assign(key, ids: string[]): { ok, error? }`, where `[]` forgets the repository
  - `Store.assigned(): Array<{ key, ws: string[] }>`
  - `Store.focus(): string` and `Store.setFocus(id): void`, the last focused workspace, kept for server-side
    notifications and new pages
  - `Store.sync(profiles)` adds a workspace for a profile seen for the first time and keeps the others

- [ ] **Step 1: Write the failing tests** in `test/workspaces.test.mjs`:
  - `defaults come from the profiles`: profiles `[{id:'default',plain:true},{id:'contract',plain:false}]` give two
    workspaces named `claude` and `claude-contract` (the folder label), with `color` `violet` and `blue`, and order
    `['contract','default']` (non-plain first).
  - `a missing, empty or corrupt file gives the defaults`: for `undefined`, `''` and `'{nope'`, `list().length === 2`
    and nothing throws.
  - `update renames and recolours, refusing a duplicate or empty name`: `update('contract',{name:'Work'})` gives
    `{ok:true}`. `update('default',{name:'work'})` gives `ok:false`. `update('default',{color:'amber'})` gives
    `ok:false`.
  - `a repository can be in one, several or no workspaces`: `assign('gh:o/n',['contract'])` then
    `reposOf('gh:o/n')` is `['contract']`. `assign('gh:o/n',['contract','default'])` gives both. `assign('gh:o/n',[])`
    then `reposOf` is `[]`. An unknown workspace id gives `ok:false`.
  - `repoKey prefers the GitHub slug`: `repoKey({slug:'o/n',common:'/x/.git'})` is `'gh:o/n'`.
    `repoKey({common:'/x/.git'})` is `'git:/x/.git'`. `repoKey({dir:'/x'})` is `'dir:/x'`.
  - `it persists privately`: after `update` and `assign`, a new `createStore` on the same file sees both, and
    `fs.statSync(file).mode & 0o777` is `0o600`.
  - `sync adds a new profile without touching the rest`: after renaming `contract` to Work, `sync` with a third
    profile `x` keeps Work and adds `claude-x` with colour `green`.

- [ ] **Step 2: Run them and see them fail**
  Run: `node --no-warnings=ExperimentalWarning --test test/workspaces.test.mjs`
  Expected: FAIL, `Cannot find module '../workspaces.mjs'`.

- [ ] **Step 3: Implement `workspaces.mjs`**
  File shape: `{ v: 1, workspaces: { [id]: { name, color } }, order: [id], repos: { [key]: [id] }, focus: id }`.
  Write it with tmp-and-rename at mode `0600`, as `watcher.mjs`'s `save()` does.

- [ ] **Step 4: Run the tests and see them pass**
  Run: `node --no-warnings=ExperimentalWarning --test test/workspaces.test.mjs`
  Expected: PASS (7 tests).

- [ ] **Step 5: Commit**
  `git add workspaces.mjs test/workspaces.test.mjs && git commit -m "feat(workspaces): the store of workspaces and where repositories belong"`

---

### Task 2: One record per workspace in the server, all of them live

This is the riskiest task. It replaces the global `profile`, `profileInfo`, `profileGen`, `configDir`, `childEnv`,
`rosterSeeded`, `rosterError` and `polls` (`server.mjs:126` and their uses) with per-workspace records, and it routes
every process to its session's workspace.

**Files:**
- Modify: `server.mjs`: the profile section (`:95-145`), `run` (`:153`), `pollRoster`/`readRoster` (`:296-370`),
  the hook routing (`:146-151`, `:396-415`, `:1971`), and every `run('claude' …)`, `spawn(… 'claude' …)` and
  `run('python3' …)` listed at `:515, 566, 594, 818, 863, 998, 1013, 1044, 1137, 1169, 1836`, plus `askModel`
  (`:1756`), `claudePath`, `ghPath`, `openTrustTerminal`, `openLoginTerminal`, `checkSetup`, `connectProfile`.
- Test: `test/workspaces-server.test.mjs` (new, end to end, built like `test/overseer-server.test.mjs`)

**Interfaces:**
- Consumes: `createStore` and `repoKey` (Task 1).
- Produces, in `server.mjs`:
  - `const W = new Map()`: `wsId → { id, profile: { id, dir, plain, config }, env, info, rosterSeeded, rosterError,
    polls, setup }`, where `setup` is today's `setup` object, now per workspace
  - `wsById(id): Ws | null`
  - `wsOfEvent(e): Ws | null`, from `e.transcript_path` under a profile's `projects/`, replacing `otherProfile` and
    `profileDirOf`
  - `envOf(ws): object`, the `CLAUDE_CONFIG_DIR` env (today's `childEnv` rule)
  - `wsOfSession(s): Ws`, where `s.ws` is set on creation from the event or roster that introduced the session
  - `pollRoster(ws): Promise<void>`, which runs today's body for one workspace. `pollAll()` calls it for each workspace.
  - `pending` entries carry `ws` (replacing `profileDir`)

- [ ] **Step 1: Write the failing end-to-end tests** in `test/workspaces-server.test.mjs`. The throwaway home has
  `.claude/` and `.claude-contract/`, each with a `projects/p/<sid>.jsonl`. The stand-in `claude` prints
  `roster-<CLAUDE_CONFIG_DIR basename or "default">.json` for `agents`, and logs `{args, env:
  process.env.CLAUDE_CONFIG_DIR ?? null}` for every other call. Tests:
  Until Task 3 the snapshot is still unsealed, so these tests read it whole and check the new `ws` field on each
  session:
  - `both workspaces' sessions are live at once`: one SSE snapshot holds both sessions, with `ws` `'default'` and
    `'contract'`. A POST to `/hook/permission` with a `transcript_path` under `.claude-contract/projects/` is held:
    the request stays open and appears in `pending` with `ws: 'contract'`. Today it is answered at once.
  - `a reply runs under the session's own profile`: POST `/api/reply` for the contract session logs a
    `claude --bg --resume` call whose `env` ends in `.claude-contract`. A reply to the default session logs
    `env: null`.
  - `a profile folder created after start becomes a workspace` (Review Focus 1): create `.claude-new/projects/p` while
    running and send a hook event whose transcript is under it. Within two roster ticks its session appears with
    `ws: 'new'`, and the event wasn't attributed to `default`.

- [ ] **Step 2: Run them and see them fail**
  Run: `node --no-warnings=ExperimentalWarning --test test/workspaces-server.test.mjs`
  Expected: FAIL. The contract request is answered at once (dropped by `otherProfile`), and the reply's env is null.

- [ ] **Step 3: Implement the per-workspace records**
  - Build `W` at start from `listProfiles()` and `store.sync()`. Re-sync on each roster tick.
  - `run` loses its default `env: childEnv`, and every caller passes `envOf(wsOfSession(s))` or `envOf(ws)`.
  - Hook events route by `wsOfEvent`. Unknown profiles trigger a sync, not a drop.
  - `pollRoster(ws)` keeps today's logic, scoped to sessions with `s.ws === ws.id` for "gone from the roster" and the
    pending backstop.
  - Remove `switchProfile`'s clearing. It is replaced by focus in Task 3.

- [ ] **Step 4: Run the new tests and the whole suite**
  Run: `node --no-warnings=ExperimentalWarning --test`
  Expected: all PASS. The existing single-profile tests must pass unchanged, which proves the one-workspace case.

- [ ] **Step 5: Commit**
  `git commit -am "feat(workspaces): every workspace is live, each process runs under its session's own profile"`

---

### Task 3: Focus per page, a sealed snapshot, and guarded actions

**Files:**
- Modify: `server.mjs`: `snapshot()` (`:1895`), `broadcast()` (`:1918`), the SSE handler (`:1924`), the
  `ACTIONS` dispatcher (`:2040`), `/api/decide`, `/api/launch`, `/api/interrupt`, and `switchProfile` →
  `focusWorkspace`
- Modify: `public/index.html`: `api()` (`:1083`) sends header `x-acp-client: CLIENT`
- Test: `test/workspaces-server.test.mjs`

**Interfaces:**
- Consumes: `W`, `wsOfSession` (Task 2), `store.focus/setFocus` (Task 1).
- Produces:
  - `focusOf(clientId): string`, from `clientFocus: Map<clientId, wsId>`, defaulting to `store.focus()`
  - `POST /api/workspace/focus { ws }` returns `{ ok }`. It sets the client's focus and `store.setFocus`, and refuses
    an unknown id. A queued unsent message keeps today's `{ confirm: true, queued }` reply unless `force`.
  - `GET /api/workspaces` returns `{ ok, workspaces: store.list(), assigned: store.assigned() }`. The list carries
    names and colours only, which is safe for any workspace.
  - `snapshot(wsId)`: today's fields filtered to `s.ws === wsId` (sessions, pending, subagents), plus
    `workspace: { id, name, color }`, `workspaces: [{ id, name, color, waiting }]` for all of them, and
    `profile: W.get(wsId).info`.
  - `waitingOf(wsId): number`, per Global Constraints.
  - `ownedBy(wsId, sessionId): boolean`, used by every action. The refusal copy is in Global Constraints.

- [ ] **Step 1: Write the failing tests**
  - `a workspace's snapshot holds nothing from the other`: focus a client on `default` and read one SSE snapshot.
    `JSON.stringify(snap)` does not include the contract session's id, its id8, its name or its folder.
    `snap.workspaces` lists both, with contract `waiting === 1` while its permission request is held.
  - `two pages, two workspaces` (Review Focus 2): clients A (default) and B (contract) each receive only their own
    sessions. POST `/api/decide` for the contract request with A's client id gives 409 and the refusal copy. With B's
    it succeeds.
  - `every session action is guarded`: for each of `/api/reply`, `/api/end`, `/api/remove`, `/api/interrupt`,
    `/api/mode`, `/api/term/open`, `/api/history`, `/api/follow`, the contract session with A's client id gives
    `ok:false` and the refusal copy.

- [ ] **Step 2: Run them and see them fail**
  Run: `node --no-warnings=ExperimentalWarning --test test/workspaces-server.test.mjs`
  Expected: FAIL. The snapshot includes both workspaces' sessions.

- [ ] **Step 3: Implement focus, `snapshot(wsId)`, `ownedBy`, and per-workspace broadcast**
  `broadcast` builds one snapshot per distinct focus among connected clients and writes each client its own.

- [ ] **Step 4: Run the whole suite**
  Run: `node --no-warnings=ExperimentalWarning --test`
  Expected: all PASS.

- [ ] **Step 5: Commit**
  `git commit -am "feat(workspaces): each page focuses a workspace; snapshots and actions are sealed to it"`

---

### Task 4: One overseer per workspace

**Files:**
- Modify: `server.mjs`: the overseer setup (`:1748-1790`), the `OVERSEER` routes, `feed()`, and `overseerBoard`
- Modify: `overseer.mjs`: add `migrateFrom(oldFile, id)`, a static helper. `use()` is no longer called.
- Test: `test/overseer.test.mjs`, `test/workspaces-server.test.mjs`

**Interfaces:**
- Consumes: `W`, `envOf`, `focusOf`, `ownedBy`.
- Produces:
  - `overseers: Map<wsId, Overseer>`, each made by `createOverseer({ file: path.join(dataDir, 'overseer-' + id +
    '.json'), ask: (args, o) => askModel(args, { ...o, env: envOf(ws) }), board: () => overseerBoard(ws), actions:
    <today's, bound to ws> })`
  - `migrateFrom(oldFile, id): object | null` in `overseer.mjs`: that profile's `{ seq, fseq, turns, feed }` from the
    shared `overseer.json`, used once to seed `overseer-<id>.json` when it is missing
  - `feed(type, s, text)` writes to `overseers.get(s.ws)`
  - The overseer routes use `overseers.get(focusOf(client))`, and `snapshot(wsId).overseer` is that one's `status()`

- [ ] **Step 1: Write the failing tests**
  - `overseer.test.mjs › migrateFrom takes one profile's conversation`: an old file with `profiles: { default: {turns:
    [a]}, contract: {turns:[b]} }` gives `migrateFrom(file,'contract').turns` equal to `[b]`.
  - `workspaces-server › each overseer reads only its own workspace`: say something to the default overseer. The
    stand-in `claude -p` logs its prompt, and that prompt does not include the contract session's id8 or name. Its
    `env` is the default profile's.
  - `workspaces-server › both overseers can answer at once`: say to default (client A) and contract (client B) within
    100 ms. Both turns arrive, and neither is "You switched profile before it answered."

- [ ] **Step 2: Run them and see them fail**
  Run: `node --no-warnings=ExperimentalWarning --test test/overseer.test.mjs test/workspaces-server.test.mjs`
  Expected: FAIL.

- [ ] **Step 3: Implement per-workspace overseers and the one-time migration**

- [ ] **Step 4: Run the whole suite**
  Run: `node --no-warnings=ExperimentalWarning --test`
  Expected: all PASS.

- [ ] **Step 5: Commit**
  `git commit -am "feat(workspaces): one overseer per workspace, each on its own login and board"`

---

### Task 5: The PR watcher, per workspace

**Files:**
- Modify: `watcher.mjs`: `mem.enabled` becomes `mem.enabledBy: { [wsId]: boolean }`. A saved `enabled` seeds every
  workspace. `setEnabled(on, ws)`, `status(ws)`, and new deps `wsOf(sessionId)` and `repoIn(slug, ws)`.
- Modify: `server.mjs`: the watcher setup (`:1711`). `send` and `suggest` route through the session's workspace.
- Test: `test/watcher.test.mjs`

**Interfaces:**
- Consumes: `store.reposOf`, `wsOfSession`, `overseers`.
- Produces: `createWatcher({ …today, wsOf, repoIn })`. It acts on a PR only when the session on its branch has
  `wsOf(sid) = w`, `enabledBy[w] !== false` and `repoIn(slug, w)`. Its memory stays keyed by `slug#number`.

- [ ] **Step 1: Write the failing tests** in `test/watcher.test.mjs`:
  - `Auto-fix is per workspace`: with `setEnabled(false,'contract')`, a failing PR whose session is in contract is not
    asked about, and one in default is.
  - `an old single switch seeds every workspace`: a saved `{v:1, enabled:false}` gives `status('default').enabled ===
    false` and `status('contract').enabled === false`.
  - `an unsorted repository is not acted on`: `repoIn` returns false, so nothing is sent.
  - `a shared repository is asked once` (Review Focus 3): sessions from both workspaces on the PR's branch, with
    `repoIn` true for both. One `send` call in total.

- [ ] **Step 2: Run them and see them fail**
  Run: `node --no-warnings=ExperimentalWarning --test test/watcher.test.mjs`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the whole suite** (`node --no-warnings=ExperimentalWarning --test`, all PASS)

- [ ] **Step 5: Commit**
  `git commit -am "feat(workspaces): the PR watcher acts per workspace, through the session's own login"`

---

### Task 6: GitHub, sealed

**Files:**
- Modify: `server.mjs`: where `snapshot` puts `github` and `gh` on sessions, the `notify` passed to
  `createGithub`, `githubLog`/`githubHand`
- Test: `test/workspaces-server.test.mjs` (the stand-in `gh` from `overseer-server.test.mjs`, now with one PR in
  `o/n` (contract) and one in `o/p` (default))

**Interfaces:**
- Consumes: `store.reposOf`, `focusOf`, `store.focus()`.
- Produces:
  - `githubFor(wsId)`: `github.state()` with `repos` kept only when `store.reposOf('gh:'+slug)` includes `wsId`. It
    adds `unsorted: <number of watched or mine repos in no workspace>`. Repos in no workspace are never listed by
    name.
  - `sessionGh(s, wsId)`: `github.forSession(...)` when the repository is in `wsId` or unsorted. It is `null`, with
    `s.mismatch` set, when the repository is only in other workspaces (Task 8 renders it).
  - `notifyFor(slug, title, text)`: when the repository is in `store.focus()`, send as today. Otherwise send
    `<Name>: a check failed`, with no slug, PR or branch.

- [ ] **Step 1: Write the failing tests**
  - `the GitHub panel lists only the workspace's repositories`: focused on default, `snap.github.repos` has `o/p` and
    not `o/n`, and `JSON.stringify(snap)` does not include `o/n`.
  - `unsorted repositories are a count`: an unassigned `o/q` gives `snap.github.unsorted === 1`, and `o/q` appears
    nowhere in the snapshot.
  - `a failing check in another workspace notifies by count only`: the test `bin` gets a stand-in `osascript` that
    logs its argv (`notify()` at `server.mjs:1646` passes the title and text as its last two arguments). With the
    focus on default and a fresh failure in `o/n` (a `completedAt` within the last minute), the logged text is exactly
    `claude-contract: a check failed`, and no logged argument contains `o/n`, `#7` or `feat/x`.

- [ ] **Step 2: Run them and see them fail**
- [ ] **Step 3: Implement `githubFor`, `sessionGh`, `notifyFor`**
- [ ] **Step 4: Run the whole suite**: all PASS
- [ ] **Step 5: Commit**
  `git commit -am "feat(workspaces): GitHub shows only the workspace's repositories; others notify by count"`

---

### Task 7: Launching in a workspace, and the folder question

**Files:**
- Modify: `server.mjs`: `launch()` (`:478`), `folderInfo()`, a new `/api/workspace/assign`
- Modify: `public/index.html`: the launcher (`openLauncher`, `:2807` area)
- Test: `test/workspaces-server.test.mjs`

**Interfaces:**
- Consumes: `repoKey`, `store`, `focusOf`, `envOf`.
- Produces:
  - `folderInfo(body)` gains `workspaces: { key, label, in: string[], suggest: string | null }`. `suggest` is the one
    workspace whose sessions alone have worked in that repository, else `null`.
  - `launch(body)` runs under `envOf(focus)`, and:
    - for an unsorted repository without `body.assign` (`string[]`), it returns `{ ok: false, ask: { key, label,
      suggest } }`;
    - with `body.assign`, it assigns, then launches;
    - for a repository not in the focus, it returns `{ ok: false, error: '<label> is in <Name>. Switch to <Name> to
      start an agent there.' }`.
  - `POST /api/workspace/assign { key, ws: string[] }` returns `{ ok }`.
  - In the page, the launcher shows `Is <label> <Focused> or <Other>?`, preselecting the focus (or `suggest`), with a
    quieter `Both`. The answer goes in `assign` on Launch. With one workspace, no question is shown and `assign` is
    `[focus]` silently.

- [ ] **Step 1: Write the failing tests**
  - `an unsorted folder asks before launching`: `/api/launch` with no `assign` gives `ask.label === 'n'`.
  - `assign then launch`: `/api/launch` with `assign:['default']` logs `claude --bg` with the default env, and
    `GET /api/workspaces` shows `gh:o/n → ['default']`.
  - `a folder in another workspace is refused`: with `gh:o/n → ['contract']` and the focus on default, the error is
    `n is in claude-contract. Switch to claude-contract to start an agent there.`
- [ ] **Step 2: Run them and see them fail**
- [ ] **Step 3: Implement the server side, then the launcher's inline choice**
- [ ] **Step 4: Run the whole suite**: all PASS
- [ ] **Step 5: Commit**
  `git commit -am "feat(workspaces): New agent launches in the focused workspace and asks where a new repository belongs"`

---

### Task 8: Sessions in unsorted or mismatched repositories

**Files:**
- Modify: `server.mjs`: the session mapping in `snapshot(wsId)`
- Modify: `public/index.html`: the session row and the details column
- Test: `test/workspaces-server.test.mjs`

**Interfaces:**
- Consumes: `sessionGh`, `store`.
- Produces, per session in a snapshot:
  - `repoAsk: { key, label, suggest } | null`, set when the repository is unsorted
  - `mismatch: { name } | null`, set when the repository is only in other workspaces. In that case `git`,
    `elsewhere`, `gh` and `workCwd` are `null`, and `cwd` is `null` too.
  - In the page, an unsorted row shows `Remember <label> as <Focused>?` with **Yes** and `It's <Other>`, which posts
    `/api/workspace/assign`. A mismatched row shows `Works in a repository from <Name>` in amber in its details, and
    its row tooltip has no folder or branch.

- [ ] **Step 1: Write the failing tests**
  - `a session in an unsorted repository is asked about`: `repoAsk.label === 'n'`.
  - `a session in another workspace's repository shows nothing of it`: a default-profile session in `o/n`, with
    `o/n → ['contract']`, has `mismatch.name === 'claude-contract'`, and `JSON.stringify(session)` includes neither
    `o/n`, `feat/x` nor the repository folder.
- [ ] **Step 2: Run them and see them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the whole suite**: all PASS
- [ ] **Step 5: Commit**
  `git commit -am "feat(workspaces): ask about unsorted repositories on the session; withhold another workspace's"`

---

### Task 9: The switch, the accent, the keys and the counts

**Files:**
- Modify: `public/index.html`: replace `#prof-tabs` and `renderProfile`'s tab code, `chooseProfile`, and the keydown
  handler. Add the accent CSS, the document title count and notifications for other workspaces.
- Test: a manual browser check (Step 4). No page test framework exists in this repo.

**Interfaces:**
- Consumes: `snap.workspace`, `snap.workspaces`, `/api/workspace/focus` (Task 3).
- Produces:
  - `#ws-switch`, a segmented control. Each half is `<name>`, plus ` ·<n>` in amber when another workspace's `waiting
    > 0`. It is hidden when `snap.workspaces.length < 2`.
  - CSS `--ws` on `:root`, set from `snap.workspace.color`: a 2 px top accent on `body`, the active half's fill, and
    the `.brand::before` mark tinted. Only when there are 2+ workspaces.
  - ⌃1–⌃9 call `chooseWorkspace(i)`, ignored while focus is in an input or textarea. On `{confirm}`, the existing
    armed-confirm behaviour applies.
  - `document.title` is `(<total>) Glue`, where the total is the focused workspace's pending plus every other
    workspace's `waiting`. The app's Dock badge reads this.
  - When another workspace's `waiting` rises, a desktop notification titled `Glue` with body `<Name>: <n> needs you`.
    Clicking it calls `chooseWorkspace` for that workspace.

- [ ] **Step 1: Implement the switch, accent, keys, title and notifications**
- [ ] **Step 2: Run the whole suite** (`node --no-warnings=ExperimentalWarning --test`, all PASS)
- [ ] **Step 3: Start a preview** with two profiles. Run
  `ACP_PORT=4799 ACP_PREFS=$CLAUDE_JOB_DIR/tmp/prefs-ws.json node server.mjs`, then check in a browser:
  - The switch shows both names.
  - ⌃2 switches instantly, with no empty board.
  - The accent changes colour.
  - A held request in the other workspace shows `·1` and raises the title count.
  - With a draft typed, switching asks first, and switching back keeps the draft (Review Focus 5).
- [ ] **Step 4: Commit**
  `git commit -am "feat(workspaces): the Work | Private switch with its accent, keys and counts"`

---

### Task 10: The GitHub panel's unsorted count, and Auto-fix per workspace

**Files:**
- Modify: `public/index.html`: `acrossNodes` (GitHub panel) and the Auto-fix switch
- Modify: `server.mjs`: `/api/watcher/enabled` takes the client's focus, and `snapshot(wsId).watcher` is
  `watcher.status(wsId)`
- Test: `test/workspaces-server.test.mjs`

**Interfaces:**
- Consumes: `snap.github.unsorted` (Task 6), `watcher.setEnabled(on, ws)` (Task 5).
- Produces:
  - In the panel, a line `<n> repositories aren't in a workspace yet · Sort` when `unsorted > 0`.
  - **Sort** opens a list from `GET /api/workspace/unsorted`. That route returns only `{ key, label }` for unsorted
    repos, and is allowed because the user is choosing where they belong. Each repo gets the same choice as the
    launcher.
  - The Auto-fix switch posts with the client's focus.

- [ ] **Step 1: Write the failing test** `Auto-fix is set for the focused workspace only`: client A turns it off, then
  `snap.watcher.enabled` is false for A and true for B.
- [ ] **Step 2: Run it and see it fail**
- [ ] **Step 3: Implement the server route, then the panel line and the Sort list**
- [ ] **Step 4: Run the whole suite**: all PASS
- [ ] **Step 5: Commit**
  `git commit -am "feat(workspaces): sort unsorted repositories from the GitHub panel; Auto-fix per workspace"`

---

### Task 11: The Workspaces step in the setup checklist, and the README

**Files:**
- Modify: `public/index.html`: `setupRows` and `renderSetup` gain a **Workspaces** row when there are 2+ workspaces
- Modify: `server.mjs`: `POST /api/workspace/update { id, name?, color? }`, which calls `store.update`
- Modify: `README.md`: replace the Profiles section with Workspaces
- Test: `test/workspaces-server.test.mjs`

**Interfaces:**
- Consumes: `store.update`, `store.assigned`, `store.assign`.
- Produces:
  - The checklist row **Workspaces** lists each workspace with a name field and five colour swatches (from `COLORS`),
    plus its repositories with **Move** (the same choice as the launcher) and **Forget**.
  - The row counts as done once any workspace has been renamed from its folder label. It is optional, and never
    blocks Done.

- [ ] **Step 1: Write the failing test** `renaming a workspace shows in both pages' snapshots`: after
  `/api/workspace/update {id:'contract', name:'Work', color:'blue'}`, client B's `snap.workspace.name === 'Work'` and
  client A's `snap.workspaces` includes `{ id:'contract', name:'Work' }`.
- [ ] **Step 2: Run it and see it fail**
- [ ] **Step 3: Implement the route, the checklist row, and the README section**
  The README covers what a workspace is, the seal, the switch and keys, folders sorted on first use, and Both.
- [ ] **Step 4: Run the whole suite**, then a browser check: rename to Work and Private, pick colours, and move a
  repository.
- [ ] **Step 5: Commit**
  `git commit -am "feat(workspaces): name and colour workspaces and move repositories from the setup checklist"`
