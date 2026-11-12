# World, slice 1: earning and persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A World view that starts as a bare planet the first time it is opened and grows from the credit your agents'
tokens and your commits earn, with today's numbers in a side panel.

**Architecture:** A new server module `world.mjs` counts tokens (from the shown profile's transcripts, read
incrementally) and commits (from `git log` in the repositories those transcripts worked in), keeps a per-profile
ledger in Application Support, and exposes a small summary. `server.mjs` wires it to the profile, a background scan,
one API route and the SSE snapshot. The page gets a World button and overlay; the drawing lives in a new plain script
`public/world.js`, served by the server.

**Tech Stack:** Node ≥ 20 standard library only (`node:test` for tests), vanilla browser JS and canvas 2D, git CLI.

**Spec:** `docs/superpowers/specs/2026-10-21-world-design.md` (read it with this plan; the mockup next to it is the
visual reference).

## Global Constraints

- No npm dependencies. No build step. Tests run with `node --test` (`npm test`).
- Every new `/api` route takes the per-start token and same-origin check like the others; nothing listens beyond 127.0.0.1.
- Git is read only. Every git call has a timeout (10 s) and runs off the request path; a failure keeps the last numbers.
- No model calls in this slice.
- World state lives in `path.join(path.dirname(PREFS), 'world', '<profile id>.json')`, so a test server started with
  its own `ACP_PREFS` never touches the real one.
- Credit per local calendar day: `credit = round((added / 10 + tokens / 10000) × multiplier)`,
  `multiplier = 1 + 3 × removed / (added + removed)` rounded to 0.1 (1 when nothing changed).
- Tokens per assistant reply: `output_tokens + input_tokens + cache_creation_input_tokens`; cache reads excluded.
- Only work after World's first open counts. Fits a 13" screen; one night sky in both themes; respects reduced motion.
- Public repository: no personal data in code, tests or fixtures.

## Review Focus

1. **One reply, many lines.** Claude Code writes one API reply as several transcript entries that repeat the same
   `message.id` and `usage`; it must count once (Task 2 test).
2. **A branch deleted after a GitHub squash merge.** The local commits become unreachable and the squash commit is
   GitHub's; credit already earned must stay (Task 3 test: commits are remembered once counted).
3. **Rebase and amend.** They rewrite hashes but keep author time and subject; they must not count twice, and the
   newest version's lines win (Task 1 test on the key, Task 3 test end to end).
4. **Big old transcripts at first open.** Files untouched since before World started are skipped, never read
   (Task 2 test); a file that shrinks is not recounted (Task 2 test).
5. **A repository where git resolves no `user.email`.** It counts nothing and is listed in the summary's
   `noEmail` so the panel can say so (Task 3 test).

---

## File structure

- Create `world.mjs`: credit math, transcript token reader, git commit reader, the per-profile store and scanner.
- Create `test/world.test.mjs`: all World tests (unit and temp-dir integration).
- Modify `server.mjs`: world per profile, scan timer, `POST /api/world/open`, `GET /world.js`, `world` in the snapshot.
- Create `public/world.js`: the World view's renderer and side panel (adapted from the mockup's canvas code).
- Modify `public/index.html`: the World button, the overlay markup and its CSS, loading `/world.js`.
- Modify `package.json` (test script), `README.md` (a World section), the design doc (two notes, Task 6).

---

### Task 1: Credit math

**Files:**
- Create: `world.mjs`
- Create: `test/world.test.mjs`
- Modify: `package.json` (add `"test": "node --test"`)

**Interfaces:**
- Produces (all exported from `world.mjs`):
  - `dayKey(ms: number): string` — local calendar day, `YYYY-MM-DD`.
  - `multiplier(added: number, removed: number): number`
  - `dayCredit({ added, removed, tokens }): number`
  - `grown(earned: number): number` — 0..1, `1 - Math.exp(-earned / 30000)`: how far Home and the map have grown.
  - `commitKey(authorTimeSec: number, subject: string): string` — `${authorTimeSec}:${sha1(subject).slice(0, 12)}`.
  - `countsFile(file: string): boolean` — false for lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
    `bun.lockb`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `composer.lock`, `go.sum` (by basename).
  - `FILE_CAP = 2000` — a file's lines in one commit count at most this many each way.

- [ ] **Step 1: Write the failing tests** (set `process.env.TZ = 'UTC'` at the top of the test file)

```js
test('multiplier rewards removing', () => {
  assert.equal(multiplier(0, 0), 1);
  assert.equal(multiplier(1000, 0), 1);
  assert.equal(multiplier(500, 500), 2.5);
  assert.equal(multiplier(0, 300), 4);
});
test('a day of work earns credit', () => {
  assert.equal(dayCredit({ added: 11000, removed: 0, tokens: 1_500_000 }), 1250);
  assert.equal(dayCredit({ added: 50, removed: 300, tokens: 0 }), Math.round(5 * 3.6));
});
test('day keys are calendar days', () => assert.equal(dayKey(Date.UTC(2026, 9, 21, 23, 59)), '2026-10-21'));
test('growth starts at nothing and never ends', () => { assert.equal(grown(0), 0); assert.ok(grown(30000) > 0.6 && grown(30000) < 0.64); assert.ok(grown(1e7) < 1); });
test('a rebased or amended commit keeps its key', () => assert.equal(commitKey(1792584000, 'fix: x'), commitKey(1792584000, 'fix: x')));
test('lockfiles do not count', () => { assert.equal(countsFile('a/package-lock.json'), false); assert.equal(countsFile('src/a.js'), true); });
```

- [ ] **Step 2: Run `npm test` — expect FAIL (module not found).**
- [ ] **Step 3: Implement the six exports in `world.mjs`** (`node:crypto` for sha1).
- [ ] **Step 4: Run `npm test` — expect PASS.**
- [ ] **Step 5: Commit** `feat(world): credit math`.

### Task 2: Tokens from transcripts

**Files:**
- Modify: `world.mjs`, `test/world.test.mjs`

**Interfaces:**
- Consumes: `dayKey`.
- Produces: `readTokens(file: string, seen: FileState | undefined, startedAt: number): { state: FileState, tokens: Record<day, number>, cwds: string[] }`
  where `FileState = { offset: number, ids: string[] }` (`ids` = the last 50 `message.id`s counted from this file).
  - A file not seen before whose mtime is before `startedAt` is not read: it returns `{ offset: size, ids: [] }`.
  - Reads from `offset` to the end, only whole lines (a trailing partial line waits for the next read).
  - Counts assistant entries with `message.usage` and `timestamp ≥ startedAt`, once per `message.id`.
  - A file now smaller than `offset` is not recounted: offset moves to its size.
  - `cwds`: the distinct absolute `cwd` values of the entries read (for finding repositories).

- [ ] **Step 1: Write the failing tests** (temp dir via `fs.mkdtempSync(path.join(os.tmpdir(), 'world-'))`; helper `reply(id, ts, usage)` writes one assistant line)

```js
test('one reply split over several entries counts once', () => {
  // two lines with message.id 'm1' and identical usage {input_tokens:2, output_tokens:57, cache_creation_input_tokens:100, cache_read_input_tokens:9999}
  const r = readTokens(file, undefined, START);
  assert.deepEqual(r.tokens, { '2026-10-21': 159 });
});
test('only new lines are read the second time', () => { /* append m2 (10 tokens); readTokens(file, r.state, START).tokens deep-equals { '2026-10-21': 10 } */ });
test('entries from before World started do not count', () => { /* timestamp START - 1000 → tokens {} */ });
test('an old file at first open is skipped, not read', () => { /* utimes to before START → offset === size, tokens {} */ });
test('a file that shrank is not recounted', () => { /* state.offset > size → tokens {}, state.offset === size */ });
test('a half-written last line waits', () => { /* file ends without \n → offset stops before it */ });
```

- [ ] **Step 2: Run `npm test` — expect the new tests to FAIL.**
- [ ] **Step 3: Implement `readTokens`** with `fs.openSync`/`fs.readSync` from `offset` (no whole-file reads of old data).
- [ ] **Step 4: Run `npm test` — expect PASS.**
- [ ] **Step 5: Commit** `feat(world): count tokens from transcripts, once per reply`.

### Task 3: Commits from git, and the store that remembers them

**Files:**
- Modify: `world.mjs`, `test/world.test.mjs`

**Interfaces:**
- Consumes: `dayKey`, `commitKey`, `countsFile`, `FILE_CAP`, `readTokens`, `dayCredit`, `grown`.
- Produces:
  - `parseLog(text: string, email: string): Array<{ key, day, added, removed }>` — `text` is the output of
    `git log --all --no-merges --since=<startedAt seconds> --format=%x1e%H%x1f%at%x1f%ae%x1f%ce%x1f%s --numstat`;
    keeps commits whose author **and** committer email equal `email` (case-insensitive); binary (`-`) lines and
    `countsFile` = false lines skipped; each file capped at `FILE_CAP` each way; `day = dayKey(at × 1000)`.
  - `createWorld({ file, configDir, gitPlace, run, now = Date.now }): World` where
    `run(cmd, args, opts) → Promise<{ err, stdout, stderr }>` (the server's `run`) and `World` is
    `{ started(): boolean, open(): void, scan({ git: boolean }): Promise<void>, summary(): Summary }`.
  - Stored JSON: `{ v: 1, startedAt, seed, files: { [path]: FileState }, tokens: { [day]: n },
    commits: { [key]: { day, added, removed } }, repos: string[], noEmail: string[], purchases: [] }`,
    written atomically (temp file + rename), created only by `open()`.
  - `scan`: reads every `<configDir>/projects/*/*.jsonl` and `*/subagents/*.jsonl` with `readTokens`, adds the git
    repo (`gitPlace(cwd)?.repo`) of each new cwd to `repos`; with `git: true`, for each repo resolves
    `git config user.email` (empty → into `noEmail`, skipped) and merges `parseLog` results into `commits`
    (a known key is replaced with the newer lines; keys are never deleted); then saves.
  - `Summary = { started, startedAt, earned, spent, balance, grown, today: { day, commits, added, removed,
    multiplier, tokens, credit }, noEmail }` — `earned` = Σ `dayCredit` over every day in `tokens` ∪ commit days;
    `spent` = Σ `purchases[].price` (0 in this slice); `balance = earned - spent`. Before `open()`, `{ started: false }`.

- [ ] **Step 1: Write the failing tests** (a temp git repo made with `git init`, `git -c user.email=me@example.com -c user.name=Me commit`; a temp `configDir/projects/p/s.jsonl` whose entries carry that repo as `cwd`)

```js
test('only my commits count, merges and lockfiles do not', async () => { /* commit by me (+3 lines), commit by other@example.com, lockfile commit by me, a merge → summary().today.added === 3 */ });
test('a squash merged on GitHub does not count again', () => { /* parseLog line with ce=noreply@github.com → [] */ });
test('credit stays after the branch is deleted', async () => { /* commit on a branch, scan, delete branch + gc, scan → today.added unchanged */ });
test('a rebased commit is not counted twice', async () => { /* commit, scan, amend --no-edit with one more line, scan → one commit, newer lines */ });
test('a repository without user.email is listed, not counted', async () => { /* repo with no email (GIT_CONFIG_GLOBAL=/dev/null in run's env) → summary().noEmail includes it */ });
test('nothing is stored until World is opened, and it survives a restart', async () => { /* summary().started === false and no file; open(); scan; new createWorld on the same file → same earned */ });
```

- [ ] **Step 2: Run `npm test` — expect the new tests to FAIL.**
- [ ] **Step 3: Implement `parseLog` and `createWorld`.** Git runs as `run('git', ['-C', repo, ...], { timeout: 10_000 })`;
  a failed git call leaves that repo's commits as they were.
- [ ] **Step 4: Run `npm test` — expect PASS.**
- [ ] **Step 5: Commit** `feat(world): count my commits and remember them`.

### Task 4: Server wiring

**Files:**
- Modify: `server.mjs`

**Interfaces:**
- Consumes: `createWorld`, `World`, `Summary` (Task 3).
- Produces: `snapshot().world: Summary`; `POST /api/world/open → { ok: true, world: Summary }`;
  `GET /world.js` → `public/world.js` (`text/javascript`, read per request like the page).

- [ ] **Step 1: In `useProfile`, (re)create `world`** for `path.join(path.dirname(PREFS), 'world', p.id + '.json')`
  with `configDir: p.dir`, the server's `gitPlace` and `run`.
- [ ] **Step 2: Scan in the background:** after `server.listen`, every 60 s `world.scan({ git: n % 5 === 0 })` when
  `world.started()`, guarded so two scans never overlap; `broadcast()` after a scan that changed `earned`.
- [ ] **Step 3: Add the routes** (`/api/world/open` goes in `ACTIONS`; it calls `open()`, starts an immediate
  `scan({ git: true })` without awaiting it, and returns the summary).
- [ ] **Step 4: Verify on a test server** — `ACP_PORT=4796 ACP_PREFS=<scratch>/prefs.json node server.mjs`; a script
  posts `/api/world/open` with the token and reads one SSE snapshot: `world.started === true`, and
  `<scratch>/world/<profile>.json` exists while `~/Library/Application Support/Agent Panel/world/` was not created.
- [ ] **Step 5: Commit** `feat(world): run World per profile in the panel server`.

### Task 5: The World view

**Files:**
- Create: `public/world.js`
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `snapshot().world`, `POST /api/world/open`, the page's `api()` and `$()`.
- Produces: `window.AgentWorld = { enter(summary), update(summary), exit() }` (in `world.js`), called by the page.

- [ ] **Step 1: The page:** a `World` button after `#space-btn`; a full-screen `#world` overlay (`hidden`) with a canvas,
  a top bar (World, the place name, the balance as `<n> credit`, Back to board) and a side panel with **Today's work**
  (commits, `+added lines written`, `−removed lines removed, so ×multiplier`, `credit earned today`) and, when
  `noEmail` is not empty, "No commits counted in <repo name>: git has no user.email there." Esc and Back close it.
  Its CSS reuses Space view's night-sky tokens. Load `/world.js` with a plain `<script src>` before the page script.
- [ ] **Step 2: `world.js`:** Home drawn from `grown` as in the mockup (`drawHome`: bare rock → oceans → land → city
  lights → atmosphere), the map lit around Home with radius `46 + 120 × grown`, the continuous zoom (wheel and
  Home/Map buttons; `scale = 40^(1 - z)`), drag to pan when zoomed out. No agents, no moments, no spending yet.
  Motion stops under `prefers-reduced-motion`; the canvas is sized to its box × `devicePixelRatio`.
- [ ] **Step 3: Opening:** the World button calls `/api/world/open`, then `AgentWorld.enter(r.world)`; each SSE
  snapshot calls `AgentWorld.update(snap.world)` while it is open.
- [ ] **Step 4: Verify** on the test server with headless Playwright at 1470×900 and 1280×800: the overlay opens, the
  balance and Today's work show the summary's numbers, Home/Map zoom works, no page errors, nothing scrolls the page;
  screenshots read back.
- [ ] **Step 5: Commit** `feat(world): the World view, Home and the map`.

### Task 6: Documentation

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-21-world-design.md`

- [ ] **Step 1: README:** a short World section: what earns credit, what counts and what doesn't (others' commits,
  GitHub squashes, lockfiles, cache reads, work from before the first open), where it is stored, and that slices 2–4
  (frontier, rockets, building) come next.
- [ ] **Step 2: Design doc notes:** the renderer lives in `public/world.js` (still no build step); commits are
  remembered once counted, keyed by author time and subject, so a deleted branch keeps its credit and a rebase
  replaces rather than adds (this supersedes "a recount can lower a past day" for commits).
- [ ] **Step 3: Run `npm test` and `node --check server.mjs world.mjs public/world.js` — expect PASS.**
- [ ] **Step 4: Commit** `docs(world): README section and design notes for slice 1`.
