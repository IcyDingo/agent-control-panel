# Easy Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One line pasted into Terminal installs the worker alone, linked to the person's account when they were signed in on the Download page, and the worker keeps itself on the release the hub runs.

**Architecture:** The hub gains three small things: it names the commit it was deployed from (`/api/release`), it mints a pre-approved device code for a signed-in owner (`POST /api/me/links`), and it serves the install script (`/install`). The Mac side gains a versioned install folder under Application Support with a fixed launcher that launchd runs, an update module that swaps the `current` link once a day, and a `login --link` that spends the pre-approved code. The panel app and its installer are untouched except for one sentence.

**Tech Stack:** Node stdlib ESM (`node:test`, `node:sqlite` in the hub), POSIX `sh` for the two scripts, launchd, macOS `tar` and `curl`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-easy-install-design.md`

## Global Constraints

- Node 20+ on the Mac; the hub runs on Node 22 (`node:sqlite`). No npm dependencies anywhere.
- Every hub answer is `{ ok: true, … }` or `{ ok: false, error: '<a sentence>' }`; copy is sentences, sentence case, no jargon.
- Secrets at rest only as sha256 (hub) or in a 0600 file (Mac). The install sends nothing but the link claim; the update check sends nothing.
- The worker lives at `~/Library/Application Support/Agent Panel/worker/`; files there: `<sha>/`, `current` (symlink), `run.sh`, `started`, `switch`, `rolled-back`, `update.json`.
- A release is a full 40-hex commit; its archive is `https://codeload.github.com/IcyDingo/agent-control-panel/tar.gz/<sha>`, whose top folder is `agent-control-panel-<sha>`.
- The link code is the device flow's own `device_code`: 15 minutes, spent on first use, label `Worker on a Mac`.
- Every new sentence the person reads is written in the plan; use it verbatim.
- Tests: `npm test -s` must stay green after every task (292 passing today). Commits carry `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

Spec-implied inputs no task's tests covered on the first pass; each now has a test in the task that owns the code.

1. **A path with a space** (`Application Support` is one): the launcher and the install script must quote every path. Task 7 runs the launcher from a folder with a space in its name; Task 8 runs the script with such a `HOME`.
2. **A dangling `current`** (an interrupted install): the launcher must say so and exit non-zero instead of exec-ing a missing file. Task 7.
3. **`HUB_RELEASE` set to a short sha** (someone ran `rev-parse --short`): the hub must ignore it and answer 503, not serve a bad archive address. Task 1.
4. **The service does not answer in time** after install: the script must say where the log is and still finish the sign-in, since the CLI needs no server. Task 8.
5. **A link code with stray characters** (a newline from a copy, a quote): `linkDeviceLogin` must trim whitespace and report anything outside `[A-Za-z0-9_-]` as spent, never send it. Task 4.

---

### Task 1: The hub names its release

**Files:**
- Modify: `hub/config.mjs` (the returned object)
- Modify: `hub/server.mjs` (a constant beside `DEFAULT_LABEL`; a route after `/healthz`)
- Modify: `hub/deploy/update.sh`, `hub/deploy/compose.yml`, `hub/deploy/README.md` (the "Every later release" line), `hub/README.md` (settings table)
- Test: `test/hub-db.test.mjs` (the config test), `test/hub-api.test.mjs`

**Interfaces:**
- Produces: `config.release: string | null` (a 40-hex sha or null). `GET /api/release` → `200 { ok: true, sha, url }` with `cache-control: public, max-age=30`, or `503 { ok: false, error: 'This hub does not name a release yet.' }`.

- [ ] **Step 1: Write the failing config test** in `test/hub-db.test.mjs`, beside the `trustProxy` assertions

```js
const SHA = 'a'.repeat(40);
assert.equal(c.release, null, 'no release until the deploy names one');
assert.equal(loadConfig({ HUB_RELEASE: SHA }).release, SHA);
assert.equal(loadConfig({ HUB_RELEASE: 'abc1234' }).release, null, 'a short sha is not a release');
assert.equal(loadConfig({ HUB_RELEASE: 'A'.repeat(40) }).release, null, 'lower-case hex only, as git prints it');
```

- [ ] **Step 2: Write the failing API test** in `test/hub-api.test.mjs`. Give the shared `hub` `HUB_RELEASE: SHA` in `before()` (define `const SHA = 'c0ffee'.padEnd(40, '0')` near `ORIGIN`); leave `off` without one.

```js
test('the hub names the release it runs; one that was not told answers 503', async () => {
  const r = await call('GET', '/api/release');
  assert.deepEqual([r.status, r.json], [200, { ok: true, sha: SHA, url: `https://codeload.github.com/IcyDingo/agent-control-panel/tar.gz/${SHA}` }]);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=30');
  const none = await call('GET', '/api/release', { on: offPort });
  assert.deepEqual([none.status, none.json], [503, { ok: false, error: 'This hub does not name a release yet.' }]);
});
```

- [ ] **Step 3: Run the two files; expect both new tests to fail** (`c.release` undefined; `/api/release` 404)

Run: `node --no-warnings=ExperimentalWarning --test test/hub-db.test.mjs test/hub-api.test.mjs`

- [ ] **Step 4: Implement.** `hub/config.mjs`: `release: /^[0-9a-f]{40}$/.test(env.HUB_RELEASE ?? '') ? env.HUB_RELEASE : null`, with a comment that it is the commit the hub was deployed from, written by `update.sh`. `hub/server.mjs`: `const RELEASE_REPO = 'IcyDingo/agent-control-panel';` and

```js
route('GET', '/api/release', 'pub', ({ res }) => (config.release
  ? send(res, 200, { ok: true, sha: config.release, url: `https://codeload.github.com/${RELEASE_REPO}/tar.gz/${config.release}` }, { cache: 'public, max-age=30' })
  : fail(res, 503, 'This hub does not name a release yet.')));
```

- [ ] **Step 5: Deploy files.** `update.sh`: after the pull, `printf 'HUB_RELEASE=%s\n' "$(git -C src rev-parse HEAD)" > release.env`. `compose.yml`: replace `env_file: .env` with

```yaml
    env_file:
      - .env
      - path: release.env
        required: false
```

`hub/deploy/README.md`: after "Every later release: `./update.sh`." add "It also writes `release.env` with the commit it deployed, which the hub serves at `/api/release`: that is the version every worker installs and updates to." `hub/README.md` settings table: `| HUB_RELEASE | none | The commit (full sha) this hub runs; workers install and update to it. The deploy script writes it; unset, /api/release answers 503. |`

- [ ] **Step 6: Run the whole suite; expect green**

Run: `npm test -s`

- [ ] **Step 7: Commit**

```bash
git add hub/config.mjs hub/server.mjs hub/deploy/update.sh hub/deploy/compose.yml hub/deploy/README.md hub/README.md test/hub-db.test.mjs test/hub-api.test.mjs
git commit -m "feat(hub): /api/release names the commit the hub was deployed from"
```

---

### Task 2: A pre-approved link code for a signed-in owner

**Files:**
- Modify: `hub/auth.mjs` (the device flow section; the returned object)
- Modify: `hub/server.mjs` (after the `/api/device/deny` route)
- Test: `test/hub-auth.test.mjs`, `test/hub-api.test.mjs`

**Interfaces:**
- Produces: `auth.linkDevice(accountId, label) → { device_code, expires_in: 900 }`. `POST /api/me/links` (web, Origin, limit `['approve', 'account']`) → `200 { ok: true, code, expires_in: 900 }`. The row is a normal `device_codes` row with `status = 'approved'`, `user_code` of the shape `LINK-XXXX`, and the minted token parked in `token_plain`; `POST /api/device/token` with `{ device_code: code }` collects it exactly as today.

- [ ] **Step 1: Write the failing auth test** in `test/hub-auth.test.mjs`, in the style of the device flow test there (`createAuth` on a temp db, a movable clock, an account id for alice; use that file's names for `auth`, `db`, `alice` and the clock)

```js
test('a link is an approved device code: one poll collects the token; a new link retires the old one and its token', () => {
  const a = auth.linkDevice(alice, 'Worker on a Mac');
  assert.equal(a.expires_in, 900);
  const row = db.prepare('SELECT user_code, status FROM device_codes WHERE account_id = ?').get(alice);
  assert.match(row.user_code, /^LINK-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
  assert.equal(row.status, 'approved');
  const b = auth.linkDevice(alice, 'Worker on a Mac');
  assert.deepEqual(auth.pollDevice(a.device_code), { status: 'expired' }, 'the first link is gone');
  const got = auth.pollDevice(b.device_code);
  assert.equal(got.status, 'ok');
  assert.equal(auth.tokenOwner(got.token).accountId, alice);
  assert.equal(auth.listTokens(alice).filter((t) => t.label === 'Worker on a Mac').length, 1, 'the retired link\'s token was revoked');
  assert.deepEqual(auth.pollDevice(b.device_code), { status: 'expired' }, 'collected once');
});
test('a link that is never collected is gone after fifteen minutes', () => {
  const { device_code } = auth.linkDevice(alice, 'Worker on a Mac');
  now += 900_001;
  assert.deepEqual(auth.pollDevice(device_code), { status: 'expired' });
});
```

- [ ] **Step 2: Write the failing API test** in `test/hub-api.test.mjs`

```js
test('a signed-in owner mints a link; the Mac turns it into a token with one poll', async () => {
  const cookie = await login('alice');
  assert.equal((await call('POST', '/api/me/links', { origin: ORIGIN })).status, 401);
  assert.equal((await call('POST', '/api/me/links', { cookie })).status, 403, 'needs the Origin');
  assert.equal((await call('POST', '/api/me/links', { token: await tokenFor('alice'), origin: ORIGIN })).status, 403, 'a Mac cannot mint links');
  const link = await call('POST', '/api/me/links', { cookie, origin: ORIGIN });
  assert.equal(link.status, 200);
  assert.equal(link.json.expires_in, 900);
  const got = await call('POST', '/api/device/token', { body: { device_code: link.json.code } });
  assert.equal(got.status, 200);
  assert.equal(got.json.account.handle, 'alice');
  const me = await call('GET', '/api/me', { cookie });
  assert.ok(me.json.tokens.some((t) => t.label === 'Worker on a Mac'));
});
```

- [ ] **Step 3: Run both files; expect the new tests to fail** (`linkDevice` is not a function; 404)

- [ ] **Step 4: Implement `linkDevice(accountId, label)` in `hub/auth.mjs`**, after `approveDevice`. Expire the account's other links first: for each row of `SELECT hash, token_plain FROM device_codes WHERE account_id = ? AND status = 'approved' AND user_code LIKE 'LINK-%'`, call `expireDevice(r)`. Then, in one transaction like `approveDevice`: pick `user_code = 'LINK-' + userCode().slice(0, 4)` until unused, `mintToken(accountId, { label, device: user_code })`, insert the row with `status 'approved'`, `account_id`, `token_plain` = the token, `expires_at = now() + DEVICE_TTL_MS`, `interval DEVICE_INTERVAL_S`, `last_poll_at NULL`. Return `{ device_code, expires_in: DEVICE_TTL_MS / 1000 }`. Add it to the returned object. One comment: a link is the device flow with the approval already given, so the same sweep, poll and expiry apply.

- [ ] **Step 5: Add the route** in `hub/server.mjs` after `/api/device/deny`:

```js
route('POST', '/api/me/links', 'web', ({ res, who }) => {
  const { device_code, expires_in } = auth.linkDevice(who.accountId, 'Worker on a Mac');
  send(res, 200, { ok: true, code: device_code, expires_in });
}, APPROVE);
```

- [ ] **Step 6: Run the suite; expect green.** Run: `npm test -s`

- [ ] **Step 7: Commit**

```bash
git add hub/auth.mjs hub/server.mjs test/hub-auth.test.mjs test/hub-api.test.mjs
git commit -m "feat(hub): POST /api/me/links mints a pre-approved device code for the signed-in owner"
```

---

### Task 3: The service can run a program of its own

**Files:**
- Modify: `daemon.mjs` (`launchdPlist`, `install`)
- Modify: `cli.mjs` (`USAGE`; the `daemon install` branch)
- Test: `test/daemon.test.mjs`

**Interfaces:**
- Produces: `launchdPlist({ label, node, repo, port, pathEnv, log, program })` and `install({ port, node, repo, pathEnv, home, run, retryMs, program })`: with `program`, `ProgramArguments` is `[program]` alone and `WorkingDirectory` is still `repo`. CLI: `node server.mjs daemon install [--program <path>]`; with `--program`, `repo` is `path.dirname(program)`.

- [ ] **Step 1: Write the failing test** in `test/daemon.test.mjs`

```js
test('with a program the plist runs that path alone, from its folder, and keeps the environment', () => {
  const xml = launchdPlist({ label: 'local.agent-panel', node: '/opt/node/bin/node', repo: '/h/Library/Application Support/Agent Panel/worker', port: 4747, pathEnv: '/usr/bin', log: '/tmp/d.log', program: '/h/Library/Application Support/Agent Panel/worker/run.sh' });
  assert.match(xml, /<key>ProgramArguments<\/key><array><string>\/h\/Library\/Application Support\/Agent Panel\/worker\/run\.sh<\/string><\/array>/);
  assert.doesNotMatch(xml, /server\.mjs/);
  assert.match(xml, /<key>WorkingDirectory<\/key><string>\/h\/Library\/Application Support\/Agent Panel\/worker<\/string>/);
  assert.match(xml, /<key>ACP_DAEMON<\/key><string>1<\/string>/);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-')), 'x.plist');
  fs.writeFileSync(f, xml);
  execFileSync('plutil', ['-lint', f]);
});
test('install passes the program through to the plist', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-'));
  const r = await install({ port: 4747, node: '/n', repo: '/w', pathEnv: '/b', home, run: fakeRun(), program: '/w/run.sh' });
  assert.match(fs.readFileSync(r.plist, 'utf8'), /<array><string>\/w\/run\.sh<\/string><\/array>/);
});
```

- [ ] **Step 2: Run it; expect failure** (`ProgramArguments` still names node and server.mjs)

Run: `node --no-warnings=ExperimentalWarning --test test/daemon.test.mjs`

- [ ] **Step 3: Implement.** `launchdPlist`: destructure `program`, build the array from `program ? [program] : [node, path.join(repo, 'server.mjs')]`. `install`: accept and pass `program`. Doc comment: a program is the worker install's launcher, which picks the version to run; without one the plist runs the server from the repo as before. `cli.mjs`: `USAGE` becomes `'usage: node server.mjs daemon install [--program <path>]|remove|status | login [--link <code>] | logout | status'`; in the `install` branch read `const program = argv[2] === '--program' && argv[3] ? argv[3] : null`, refuse any other extra argument with `USAGE` and code 2, and use `repo = program ? path.dirname(program) : <today's>`; pass `program` to `install`. (The `login --link` half of the usage line is Task 4's.)

- [ ] **Step 4: Run the suite; expect green.** Run: `npm test -s`

- [ ] **Step 5: Commit**

```bash
git add daemon.mjs cli.mjs test/daemon.test.mjs
git commit -m "feat(daemon): the service can run a launcher program instead of node server.mjs"
```

---

### Task 4: Signing in with a link

**Files:**
- Modify: `hub.mjs` (after `pollDeviceLogin`; the returned object)
- Modify: `cli.mjs` (`login`, `main`)
- Test: `test/hub-client.test.mjs`

**Interfaces:**
- Consumes: Task 2's `POST /api/device/token` behaviour for a link code.
- Produces: `hub.linkDeviceLogin(code) → Promise<'ok' | 'spent' | 'error'>`: `ok` wrote `token` and `account` to `hub.json` like `pollDeviceLogin`; `spent` means the hub answered 404, 410 or 403 (or the code is malformed) and the caller should fall back to a device login; `error` means unreachable or an unexpected answer. CLI: `node server.mjs login [--link <code>]`.

- [ ] **Step 1: Write the failing tests** in `test/hub-client.test.mjs`

```js
test('a link signs in with one poll and keeps the file private', async () => {
  const s = setup((c) => (c.url.endsWith('/api/device/token') ? json({ ok: true, token: 'hub_linked', account: ACCOUNT }) : json({}, 404)));
  assert.equal(await s.hub.linkDeviceLogin(' dc-link\n '), 'ok', 'whitespace around a pasted code is forgiven');
  assert.equal(s.fetch.calls.length, 1);
  assert.deepEqual(JSON.parse(s.fetch.calls[0].body), { device_code: 'dc-link' });
  assert.deepEqual([s.read().token, s.read().account.handle], ['hub_linked', 'ada']);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(s.hub.status().loggedIn, true);
});
test('a spent, unknown or refused link is reported as spent; an unreachable hub is an error; a malformed code is never sent', async () => {
  for (const status of [410, 404, 403]) {
    const s = setup(() => json({ ok: false, error: 'x' }, status));
    assert.equal(await s.hub.linkDeviceLogin('dc'), 'spent', String(status));
    assert.equal(s.hub.status().loggedIn, false);
  }
  const down = setup(() => { throw new Error('ECONNREFUSED'); });
  assert.equal(await down.hub.linkDeviceLogin('dc'), 'error');
  const bad = setup(() => json({ ok: true, token: 't', account: ACCOUNT }));
  assert.equal(await bad.hub.linkDeviceLogin('dc"; rm -rf /'), 'spent');
  assert.equal(bad.fetch.calls.length, 0);
});
```

- [ ] **Step 2: Run it; expect failure** (`linkDeviceLogin` is not a function)

Run: `node --no-warnings=ExperimentalWarning --test test/hub-client.test.mjs`

- [ ] **Step 3: Implement `linkDeviceLogin(code)` in `hub.mjs`.** Extract the "200 with a token" branch of `pollDeviceLogin` into `function acceptToken(body)` (returns `save()`), and use it from both. `linkDeviceLogin`: `const c = String(code ?? '').trim(); if (!/^[A-Za-z0-9_-]{1,200}$/.test(c)) return 'spent';` then `request('POST', '/api/device/token', { body: { device_code: c } })`; 200 with `token` → `acceptToken(r.body) ? 'ok' : 'error'`; 404, 410, 403 → `'spent'`; anything else → `'error'`. Export it in the returned object. Comment: a link is a device code the owner approved on the website before the Mac ever asked, so there is nothing to wait for.

- [ ] **Step 4: The CLI.** In `cli.mjs`, `main`: `if (cmd === 'login' && (argv.length === 1 || (argv.length === 3 && argv[1] === '--link'))) return login(argv[2] ?? null);`. In `login(link)`: when already signed in print exactly

```
Already signed in as @HANDLE. This Mac stays linked to @HANDLE; to switch, run `node server.mjs logout` and then the line again.
```

and return 0. Then, if `link`: `const out = await hub.linkDeviceLogin(link)`; `ok` → print `Linked to @HANDLE. Your galaxy: ${hub.status().url}/@HANDLE` and return 0; `error` → `console.error('The hub could not be reached. Run the line again in a moment.')`, return 1; `spent` → `console.log('That link was already used or has run out; signing in the usual way.')` and continue into today's device flow unchanged.

- [ ] **Step 5: Run the suite; expect green.** Run: `npm test -s`

- [ ] **Step 6: Commit**

```bash
git add hub.mjs cli.mjs test/hub-client.test.mjs
git commit -m "feat(cli): login --link signs in with a code the owner approved on the website"
```

---

### Task 5: World skips git when Apple's tools are missing

**Files:**
- Modify: `world.mjs` (`scanCommits`, `summary`)
- Test: `test/world.test.mjs`

**Interfaces:**
- Produces: `summary().toolsMissing: boolean` (true after a scan found no Command Line Tools; the panel may use it later).

- [ ] **Step 1: Write the failing test** in `test/world.test.mjs`, after "a repository whose log fails is listed"

```js
test('without Apple\'s Command Line Tools no git is run, so a background job never gets the install dialog', async () => {
  const r = repo(), calls = [];
  const spy = (cmd, args, opts) => { calls.push([cmd, ...args]); return cmd === 'xcode-select' ? Promise.resolve({ err: new Error('exit 2'), stdout: '', stderr: 'xcode-select: error: unable to get active developer directory' }) : run(cmd, args, opts); };
  const configDir = tmp();
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  const world = createWorld({ file: path.join(tmp(), 'w.json'), configDirs: [configDir], run: spy, gitPlace: () => ({ repo: r }), now: () => T0 });
  world.open();
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'), reply('m1', T0 + 5000, { output_tokens: 1 }, r));
  await world.scan({ git: true });
  assert.deepEqual(calls.filter((c) => c[0] === 'git'), []);
  assert.equal(world.summary().toolsMissing, true);
  assert.deepEqual(world.summary().gitFailed, []);
});
```

- [ ] **Step 2: Run it; expect failure** (git was called; `toolsMissing` undefined)

Run: `node --no-warnings=ExperimentalWarning --test test/world.test.mjs`

- [ ] **Step 3: Implement.** In `createWorld`, a closure variable `let toolsMissing = false`. At the top of `scanCommits`: `const dev = await run('xcode-select', ['-p'], { timeout: 10_000 }); toolsMissing = Boolean(dev.err) || !dev.stdout.trim(); if (toolsMissing) { st.noEmail = []; st.gitFailed = []; return; }`. Comment: without the tools `/usr/bin/git` is Apple's stub, which answers every call with a dialog offering to install them; a background job must never trigger that. Add `toolsMissing` to the object `summary()` returns (not to the saved file; `valid` would not know it).

- [ ] **Step 4: Run the suite; expect green** (the other scan tests pass `xcode-select` through to the real one, which answers on a dev Mac)

Run: `npm test -s`

- [ ] **Step 5: Commit**

```bash
git add world.mjs test/world.test.mjs
git commit -m "fix(world): the commit scan runs no git when Apple's Command Line Tools are missing"
```

---

### Task 6: The worker updates itself

**Files:**
- Create: `update.mjs`
- Modify: `server.mjs` (imports; a constant beside `DAEMON`; `snapshot()`; the `listen` callback)
- Modify: `cli.mjs` (the `status` command)
- Test: `test/update.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1's `GET /api/release`.
- Produces, in `update.mjs`:
  - `export const SHA_RE = /^[0-9a-f]{40}$/`
  - `export function workerOf(scriptDir) → { dir, sha } | null`: the real path of `scriptDir` must be `<dir>/<sha>` with `path.basename(dir) === 'worker'`.
  - `export function markStarted(worker)`: writes `<dir>/started` = `sha + '\n'`.
  - `export function autoUpdate(dir) → boolean`: false only when `<dir>/update.json` parses to an object with `auto === false`.
  - `export function rolledBack(dir) → { sha, at } | null`: parsed from `<dir>/rolled-back` (`<sha> <iso time>`).
  - `export function prune(worker)`: removes every `SHA_RE`-named folder in `dir` except `worker.sha`, `current`'s target, and the shas named in `switch` and `rolled-back`; also stale `*.tmp` folders and `*.tgz` files.
  - `export async function checkForUpdate({ worker, hubUrl, fetch = globalThis.fetch, run, now = Date.now, exit = (c) => process.exit(c), log = console.log }) → Promise<{ outcome: 'off' | 'current' | 'switched' | 'error', error? }>`.
- `server.mjs`: `snapshot().version` = the running sha or null; `snapshot().rolledBack` = `rolledBack(dir)` or null. CLI `status` prints `Worker <7 chars of sha>` as its first line when it runs from a worker folder.

- [ ] **Step 1: Write the failing tests** in `test/update.test.mjs`. Fixture: a temp `worker/` with `<A>/server.mjs` (an empty file) and `current → <A>`; `A = '1'.repeat(40)`, `B = '2'.repeat(40)`; an archive built with the real `tar -czf` from a temp folder named `agent-control-panel-<B>` containing `server.mjs`; a fake `fetch` answering `/api/release` with `{ ok: true, sha, url: 'http://hub.test/archive.tgz' }` and `/archive.tgz` with the file's bytes; `run` = the same execFile wrapper `world.test.mjs` uses; `exit` a spy that records the code and does not exit.

```js
test('workerOf recognises <…>/worker/<sha> through the current link and nothing else', ...)
  // workerOf(path.join(dir, 'current')) → { dir, sha: A }; workerOf(os.tmpdir()) → null; workerOf(path.join(dir, 'not-a-sha')) → null
test('the same sha does nothing but prune', ...)
  // leave a stray <'3'.repeat(40)> folder and a stale B.tmp; outcome 'current'; stray gone; current untouched; exit not called
test('a new sha is downloaded, verified, switched and the process asked to exit', ...)
  // outcome 'switched'; fs.readlinkSync(current) ends with B; <B>/server.mjs exists; `switch` reads `${B} ${A} 0\n`; exit called with 0; no .tgz or .tmp left
test('an archive with the wrong top folder is discarded and nothing changes', ...)
  // archive from a folder named agent-control-panel-main; outcome 'error'; current → A; no <B> folder; no switch; exit not called
test('a hub that answers no release, or an unreachable one, is an error and nothing changes', ...)
  // 503 → 'error'; fetch throws → 'error'
test('{ "auto": false } never asks the hub', ...)
  // write update.json; outcome 'off'; fetch.calls.length 0
test('markStarted and rolledBack read and write their one-line files', ...)
  // markStarted → started == A + '\n'; rolledBack(dir) null; write `${B} 2026-10-22T10:00:00Z\n` → { sha: B, at: '2026-10-22T10:00:00Z' }
```

- [ ] **Step 2: Run it; expect failure** (module not found)

Run: `node --no-warnings=ExperimentalWarning --test test/update.test.mjs`

- [ ] **Step 3: Implement `update.mjs`.** `checkForUpdate`: `autoUpdate(dir)` false → `{ outcome: 'off' }`. Fetch `${hubUrl}/api/release` with an 8 s `AbortSignal.timeout`; not ok or `!SHA_RE.test(sha)` → `{ outcome: 'error', error }`. Same sha → `prune(worker)`, `{ outcome: 'current' }`. Else: download `url` to `<dir>/<sha>.tgz` (`arrayBuffer` → `writeFileSync`), `mkdirSync(<dir>/<sha>.tmp)`, `run('tar', ['-xzf', tgz, '-C', tmp])`, require `readdirSync(tmp)` to equal `[\`agent-control-panel-${sha}\`]`, `renameSync` it to `<dir>/<sha>` (remove a leftover first), write `<dir>/switch` = `${sha} ${worker.sha} 0\n`, swap the link with `symlinkSync(<dir>/<sha>, <dir>/current.new)` then `renameSync(current.new, current)` (rename replaces the link itself, never its target), remove the tgz and tmp, `prune`, `log('worker: switching to <sha>')`, `exit(0)`, return `{ outcome: 'switched', sha }`. Every failure path removes what it made and returns `error`; nothing throws.

- [ ] **Step 4: Wire the server.** `server.mjs`: `import { workerOf, markStarted, rolledBack, checkForUpdate } from './update.mjs';` (and `fileURLToPath` from `node:url` if it is not imported yet), `const WORKER = workerOf(path.dirname(fileURLToPath(import.meta.url)));`, `const UPDATE_FIRST_MS = 600_000, UPDATE_MS = 86_400_000;`. In `snapshot()`: `version: WORKER?.sha ?? null, rolledBack: WORKER ? rolledBack(WORKER.dir) : null`. In the `listen` callback, after the World start:

```js
if (DAEMON && WORKER) { // only a worker install updates itself; a service from a clone is the app's and never does
  markStarted(WORKER);
  const check = () => checkForUpdate({ worker: WORKER, hubUrl: hub.status().url, run }).then((r) => { if (r.outcome === 'error') console.error('update check:', r.error); });
  setTimeout(check, UPDATE_FIRST_MS);
  setInterval(check, UPDATE_MS);
}
```

`cli.mjs` `status`: `const w = workerOf(path.dirname(fileURLToPath(import.meta.url))); if (w) console.log(\`Worker ${w.sha.slice(0, 7)}\`);` before `hubLine()`.

- [ ] **Step 5: Run the suite; expect green.** Run: `npm test -s`

- [ ] **Step 6: Commit**

```bash
git add update.mjs server.mjs cli.mjs test/update.test.mjs
git commit -m "feat(worker): a daily check installs the hub's release beside the running one and switches to it"
```

---

### Task 7: The launcher

**Files:**
- Create: `launcher.sh`
- Test: `test/worker-run.test.mjs` (new)

**Interfaces:**
- Produces: `launcher.sh`, a POSIX `sh` script with the literal `__NODE__` where the installer writes the node path. Copied by the installer to `<dir>/run.sh`; the plist runs it (Task 3's `program`). Reads `<dir>/current`, `<dir>/switch` (`<to> <from> <tries>`), `<dir>/started`; writes `switch`, `rolled-back` (`<to> <iso time>`), and re-points `current`.

- [ ] **Step 1: Write the failing test** in `test/worker-run.test.mjs`. Fixture: a temp dir whose path contains a space (`fs.mkdtempSync(path.join(os.tmpdir(), 'wo rker-'))`), inside it `worker/` with `<A>/server.mjs`, `<B>/server.mjs`, `current → <A>`; `run.sh` = `launcher.sh` with `__NODE__` replaced by the path of a stub `node` (a two-line sh script: `printf '%s\n' "$@" >> "$STUB_LOG"; exit 0`). Run with `execFile('/bin/sh', [runSh], { env: { ...process.env, STUB_LOG } })`.

```js
test('with no switch the launcher runs current/server.mjs', ...)          // log's one line ends with /current/server.mjs; exit 0
test('a switch whose version has started is removed', ...)                // current → B, switch `${B} ${A} 1`, started `${B}` → switch gone, server run
test('a version that never starts is rolled back on the third try', ...)  // current → B, switch `${B} ${A} 2`, started `${A}` → current → A, switch gone, rolled-back begins with `${B} 20`, server run from A
test('an earlier try only counts up', ...)                                 // switch `${B} ${A} 0` → switch `${B} ${A} 1`, current still B
test('a missing current is a sentence and a non-zero exit, not an exec of nothing', ...) // unlink current → exit code 1, stderr includes 'worker/current is missing'
```

- [ ] **Step 2: Run it; expect failure** (no `launcher.sh`)

Run: `node --no-warnings=ExperimentalWarning --test test/worker-run.test.mjs`

- [ ] **Step 3: Write `launcher.sh`** (under 40 lines, `#!/bin/sh`, `set -u`, every path double-quoted, `ln -sfn` to re-point the link because macOS `ln -n` does not follow an existing link):

```sh
#!/bin/sh
# The Agent Panel worker's launcher. launchd runs this; it runs the current version of the worker and, while a new
# version is being tried, puts the previous one back when the new one cannot start three times in a row. The installer
# writes this file once; the worker never updates it, so it is always there to fall back on.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="__NODE__"
if [ -f "$DIR/switch" ]; then
  read -r to from tries < "$DIR/switch"
  if [ "$(cat "$DIR/started" 2>/dev/null)" = "$to" ]; then
    rm -f "$DIR/switch"
  else
    tries=$((tries + 1))
    if [ "$tries" -ge 3 ]; then
      ln -sfn "$DIR/$from" "$DIR/current"
      printf '%s %s\n' "$to" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/rolled-back"
      rm -f "$DIR/switch"
    else
      printf '%s %s %s\n' "$to" "$from" "$tries" > "$DIR/switch"
    fi
  fi
fi
[ -f "$DIR/current/server.mjs" ] || { echo "worker/current is missing; run the install line again" >&2; exit 1; }
exec "$NODE" "$DIR/current/server.mjs"
```

- [ ] **Step 4: Run the suite; expect green.** Run: `npm test -s`

- [ ] **Step 5: Commit**

```bash
git add launcher.sh test/worker-run.test.mjs
git commit -m "feat(worker): a fixed launcher runs the current version and rolls back one that cannot start"
```

---

### Task 8: The install script

**Files:**
- Create: `hub/public/install.sh`
- Test: `test/install-sh.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1's `/api/release` JSON (`{"ok":true,"sha":"…","url":"…"}` with no spaces, as `JSON.stringify` prints it), Task 3's `daemon install --program`, Task 4's `login --link`, Task 7's `launcher.sh` inside the archive.
- Produces: `hub/public/install.sh`, POSIX `sh`, at most 150 lines, flags `--link <code>`, `--no-update`, `--uninstall`, `--help`. `ACP_HUB` overrides the hub address (default `https://universe.cashegg.com`). Exit 0 done, 1 something missing or failed, 2 bad arguments.

- [ ] **Step 1: Write the failing test** in `test/install-sh.test.mjs`. Fixture per test: a temp `HOME` with a space in its name; a `stubs/` folder first on a `PATH` that is otherwise `/usr/bin:/bin:/usr/sbin:/sbin` (so the real `node` is out of reach); stubs are sh scripts:
  - `node`: appends `"$*"` to `$STUB_LOG`; `-p process.versions.node` prints `${STUB_NODE_VERSION:-22.1.0}`; `*daemon install*` makes `$HOME/Library/LaunchAgents/` and writes `local.agent-panel.plist` there containing the argument after `--program`, then prints `Background service local.agent-panel installed`; `*daemon remove` prints `Background service removed`; `*login*` prints `Linked to @ada.`
  - `curl`: a URL ending `/api/release` prints `$STUB_RELEASE`; `-o FILE` copies `$STUB_ARCHIVE` to FILE; a URL containing `127.0.0.1:4747` exits `${STUB_READY:-0}`.
  - `xcode-select`: exits `${STUB_XCODE:-0}` after printing `/Library/Developer/CommandLineTools`.
  - `claude`: prints `2.1.310 (Claude Code)`.
  - The archive: `tar -czf` of a temp folder `agent-control-panel-<SHA>` holding `server.mjs` and the repo's real `launcher.sh`.
  Run with `execFile('/bin/sh', [script, ...args], { env })` and collect stdout, stderr, code.

```js
test('without node it stops with the nodejs.org sentence', ...)       // no node stub; code 1; stdout includes 'Install Node from nodejs.org (the LTS installer), then run the line again.'
test('it installs the release into worker/<sha>, writes the launcher, installs the service through it and links', ...)
  // args ['--link', 'dc-xyz']; code 0; <HOME>/Library/Application Support/Agent Panel/worker/<SHA>/server.mjs exists;
  // readlink current ends with /<SHA>; run.sh exists, contains the stub node path, not '__NODE__'; mode has +x;
  // no <SHA>.tgz or .tmp left; node log has a line matching /daemon install --program .*\/worker\/run\.sh$/ and one ending 'login --link dc-xyz';
  // the plist exists; stdout includes 'Linked to @ada.'
test('without a link it signs in the usual way', ...)                 // node log line ends with ' login' exactly
test('missing Command Line Tools is a sentence, not a stop', ...)      // STUB_XCODE=1; code 0; stdout includes "Commits won't count until you run  xcode-select --install"
test('--no-update writes update.json', ...)                           // file equals '{ "auto": false }\n'
test('a service from another folder is taken over, and says so', ...) // pre-write a plist with /Users/x/agent-control-panel/server.mjs; stdout includes 'A background service already runs from another folder'
test('when the service does not answer it says where the log is and still signs in', ...) // STUB_READY=1; stdout includes 'daemon-4747.log'; node log has the login line; code 0
test('a release the script cannot read is a stop', ...)               // STUB_RELEASE='{"ok":false,"error":"This hub does not name a release yet."}'; code 1; stdout includes 'The hub did not name a release'
test('--uninstall removes the service and the folder and lists what is left', ...)
  // after an install: code 0; worker/ gone; node log has 'daemon remove'; stdout includes 'hub.json' and 'Logs/Agent Panel'
```

- [ ] **Step 2: Run it; expect failure** (no script)

Run: `node --no-warnings=ExperimentalWarning --test test/install-sh.test.mjs`

- [ ] **Step 3: Write `hub/public/install.sh`.** Shape, top to bottom (the voice and the `ok`/`warn`/`fail` helpers are the app installer's, rewritten for `sh`: no `[[`, no arrays, `printf` only):

1. Header comment: what it does, the flags, that the Download page links to this file so it can be read before it runs.
2. `HUB="${ACP_HUB:-https://universe.cashegg.com}"`, `SUPPORT="$HOME/Library/Application Support/Agent Panel"`, `DIR="$SUPPORT/worker"`, `PLIST="$HOME/Library/LaunchAgents/local.agent-panel.plist"`, `LOG="$HOME/Library/Logs/Agent Panel/daemon-4747.log"`. Flag loop over `"$@"` with a `case`; `--link` takes the next argument.
3. `--uninstall`: if `"$DIR/current/server.mjs"` exists and `node` is on PATH, `node "$DIR/current/server.mjs" daemon remove`; else `launchctl bootout "gui/$(id -u)/local.agent-panel" 2>/dev/null; rm -f "$PLIST"`. `rm -rf "$DIR"`. Print: `Removed the worker.` then `Still here, in case you come back: "$SUPPORT/hub.json" (your sign-in), "$SUPPORT/world" (your galaxy's record) and ~/Library/Logs/Agent Panel. To remove them too: rm -rf "$SUPPORT" ~/Library/Logs/"Agent Panel"`. Exit 0.
4. Checks, printing `Checking what the worker needs:`: `uname` Darwin or stop; `sw_vers -productVersion` ≥ 14 or `fail`; `node` on PATH with `node -p process.versions.node` ≥ 20, else `fail "Node: Install Node from nodejs.org (the LTS installer), then run the line again."`; `xcode-select -p` or `warn "Apple's Command Line Tools: Commits won't count until you run  xcode-select --install ; tokens count from now."`; `claude` on PATH or `warn "Claude Code isn't installed yet; your galaxy grows once it is used."`. Any `fail` → `Fix the ✗ lines above, then run the line again.`, exit 1. Version compare with `sort -V | head -1` as the app installer does.
5. Takeover: if `"$PLIST"` exists and `grep -qF "$DIR/run.sh" "$PLIST"` fails → `warn "A background service already runs from another folder; it now runs from the worker install and updates itself. The app keeps working with it."`
6. Release: `release="$(curl -fsSL "$HUB/api/release")"`; `sha` via `sed -n 's/.*"sha":"\([0-9a-f]\{40\}\)".*/\1/p'`, `url` via `sed -n 's/.*"url":"\([^"]*\)".*/\1/p'`; either empty → `fail "The hub did not name a release (is $HUB reachable?)."`, exit 1. Print `Getting the worker (release ${sha_short})…` with the first 7 characters.
7. Download and unpack: `mkdir -p "$DIR"`; `tmp="$DIR/$sha.tmp"`, `rm -rf "$tmp"; mkdir "$tmp"`; `curl -fsSL "$url" -o "$DIR/$sha.tgz"`; `tar -xzf "$DIR/$sha.tgz" -C "$tmp"`; require `-d "$tmp/agent-control-panel-$sha"` else `fail "The archive did not look like the release."`, clean up, exit 1; `rm -rf "$DIR/$sha"; mv "$tmp/agent-control-panel-$sha" "$DIR/$sha"; rm -rf "$tmp" "$DIR/$sha.tgz"`.
8. Launcher and link: `sed "s|__NODE__|$(command -v node)|" "$DIR/$sha/launcher.sh" > "$DIR/run.sh"; chmod 755 "$DIR/run.sh"`; `ln -sfn "$DIR/$sha" "$DIR/current"`; `rm -f "$DIR/switch"`; with `--no-update`: `printf '{ "auto": false }\n' > "$DIR/update.json"`.
9. Service: `ACP_NODE="$(command -v node)" node "$DIR/current/server.mjs" daemon install --program "$DIR/run.sh"` or `fail` + exit 1. Wait up to 10 s (20 × `sleep 0.5`) for `curl -fsS --max-time 2 http://127.0.0.1:4747/`; answered → `ok "The worker is running"`, else `warn "The worker hasn't answered yet; its log is $LOG"`.
10. Sign-in: with a link, `node "$DIR/current/server.mjs" login --link "$link"`; without, `node "$DIR/current/server.mjs" login`.
11. Done text:

```
Done. The worker runs in the background from now on, also after a restart, and your galaxy grows from your agents'
work. See it at HUB/@you (the sign-in above printed the address). The worker checks HUB for a new release once a
day and updates itself; to turn that off:   printf '{ "auto": false }\n' > "DIR/update.json"
To remove everything:   curl -fsSL HUB/install | sh -s -- --uninstall
Want the session board too? HUB/download has the app.
```

(with `$HUB` and `$DIR` expanded.)

- [ ] **Step 4: Run the suite; expect green.** Run: `npm test -s`

- [ ] **Step 5: Commit**

```bash
git add hub/public/install.sh test/install-sh.test.mjs
git commit -m "feat(install): one line installs the worker, its launcher and service, and links the Mac"
```

---

### Task 9: The hub serves the script and the new Download page

**Files:**
- Modify: `hub/server.mjs` (`TYPES`, `STATIC`, `withVersions`)
- Modify: `hub/public/download.html`, `hub/public/hub.css` (only if a new rule is needed)
- Modify: `hub/deploy/README.md` (the Cloudflare rule)
- Test: `test/hub-api.test.mjs`

**Interfaces:**
- Consumes: Task 8's `hub/public/install.sh`, Task 2's `POST /api/me/links`, `Hub.api` and `Hub.me` from `hub/public/hub.js`.
- Produces: `GET /install` and `GET /install.sh` → the script, `text/plain; charset=utf-8`, `no-cache`, ETag. Pages are not rewritten for `"/install"`.

- [ ] **Step 1: Write the failing tests** in `test/hub-api.test.mjs`

```js
test('the install script is served as plain text at /install and /install.sh, never cached long', async () => {
  for (const p of ['/install', '/install.sh']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.ok(r.text.startsWith('#!/bin/sh'));
    assert.ok(r.text.includes('https://universe.cashegg.com'));
  }
});
test('the download page leads with the one line, links the script to read, and keeps the app as the second block', async () => {
  const r = await call('GET', '/download');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Get the worker'));
  assert.ok(r.text.includes('href="/install"'), 'the script link is not rewritten with a version');
  assert.ok(r.text.includes('Want the session board too?'));
  assert.ok(r.text.includes('./install.sh'));
});
```

- [ ] **Step 2: Run the file; expect failure** (404; old copy)

- [ ] **Step 3: Serve the script.** `TYPES`: add `'.sh': 'text/plain; charset=utf-8'`. `STATIC`: add `'/install': path.join(HERE, 'public', 'install.sh')` and `'/install.sh'` → the same file. `withVersions`: skip when `['.txt', '.sh'].includes(path.extname(file))` (a script has no version link, and the pages link `/install` by its plain address).

- [ ] **Step 4: Rewrite `hub/public/download.html`** keeping the bar, footer, mosaic and `Hub.me()` wiring as they are. `<title>Download · Universe</title>`; the first section (`.get.g24`) becomes:
  - `<h1 id="get-h">Get the worker</h1>`
  - `<p>One line in Terminal. It installs a small background service that counts your agents' work and keeps your galaxy here up to date. You need a Mac on macOS 14 or newer and Node 20 or newer. Claude Code does the rest; with Apple's Command Line Tools your commits count too.</p>`
  - the code box: `<pre id="install"></pre>` filled by script with `curl -fsSL ${location.origin}/install | sh` and, signed in with a link, `curl -fsSL ${location.origin}/install | sh -s -- --link ${code}`; the Copy button as today.
  - under the box, `<p class="note" id="link-note"></p>`: signed in, `This line links the worker to @handle. It works once, for 15 minutes.` followed by a `<button class="btn small" id="relink">Make a new link</button>`; signed out, `Sign in with GitHub first and the line links the worker for you; or run it now and approve a code in the browser.`; when `POST /api/me/links` fails, the plain line and `A link could not be made right now; run the line and approve the code in the browser.`
  - a line `<p class="more"><a href="/install">Read the script</a> before you run it.</p>`
  The second section (`.then.g24`, heading `<h2>Want the session board too?</h2>`) carries the old page's three lines (`git clone …`, `cd …`, `./install.sh`) in a code box, the old requirements sentence (macOS 14, Claude Code 2.1.303, Node 20, Apple's Command Line Tools), and one sentence: `It installs Agent Panel.app and takes the background service over from the worker; your galaxy stays as it is.` Script: on load `Hub.me()`; signed in → `Hub.api('POST', '/api/me/links')` and render; `#relink` repeats it. A new `.note` rule in `hub.css` only if `.get p` does not already fit (14.5px dim text).

- [ ] **Step 5: Cloudflare note.** In `hub/deploy/README.md`, the rule becomes

```
(http.host eq "universe.cashegg.com" and (starts_with(http.request.uri.path, "/api/") or http.request.uri.path in {"/install" "/install.sh"}))
```

with the sentence: "`/install` is fetched by `curl`, which the bot check would otherwise challenge; the rule is edited in the Cloudflare dashboard, not by any script here."

- [ ] **Step 6: Run the suite; expect green.** Run: `npm test -s`

- [ ] **Step 7: Commit**

```bash
git add hub/server.mjs hub/public/download.html hub/public/hub.css hub/deploy/README.md test/hub-api.test.mjs
git commit -m "feat(hub): the Download page leads with the one line, and /install serves the script"
```

---

### Task 10: The app installer knows the worker; the README leads with the line

**Files:**
- Modify: `install.sh` (before "Installing the background service")
- Modify: `README.md` (Get started; the Uninstall section)

- [ ] **Step 1: `install.sh`.** Before the daemon install, when `-e "$HOME/Library/Application Support/Agent Panel/worker/current"`: `warn "The background service will run from this folder from now on (it was running from the worker install)."` Nothing else changes; `daemon install` already replaces the plist.

- [ ] **Step 2: Verify by hand** that `bash -n install.sh` passes and the line reads right.

Run: `bash -n install.sh && grep -n "worker install" install.sh`

- [ ] **Step 3: README "Get started".** Lead with the worker: "You need a Mac (macOS 14 or newer) with Node 20 or newer. Open https://universe.cashegg.com/download, sign in with GitHub, and paste the one line it shows into Terminal:" then the line `curl -fsSL https://universe.cashegg.com/install | sh`, then: "It installs a small background service that counts your agents' work and keeps your galaxy up to date, and links this Mac to your account. The worker updates itself once a day. Your galaxy page is the whole interface; the Mac app below is optional." Keep today's clone-and-`./install.sh` steps under a new sub-heading `### The session board (optional)`, with the sentence that it takes the background service over from the worker. In "Uninstall", add the worker's line: `curl -fsSL https://universe.cashegg.com/install | sh -s -- --uninstall`.

- [ ] **Step 4: Run the suite; expect green.** Run: `npm test -s`

- [ ] **Step 5: Commit**

```bash
git add install.sh README.md
git commit -m "docs: Get started leads with the one line; the app installer says when it takes the service over"
```

---

## After the last task

- Deploy: on the server, `cp src/hub/deploy/compose.yml .` then `./update.sh` (it writes `release.env` for the first time). Then edit the Cloudflare rule as Task 9's README says.
- Manual check on a clean user account on this Mac: the one line from the Download page, signed in; the galaxy page shows the Mac; `node server.mjs status` from `worker/current` prints the sha; `install.sh` from a clone on top keeps the galaxy and says it takes the service over.
- Not in this round, by the spec: telling the hub about a rollback, a signed release, Homebrew.
