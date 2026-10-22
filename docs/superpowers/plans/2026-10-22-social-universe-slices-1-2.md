# Social universe, slices 1–2: headless install, the sun, the public projection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer runs `./install.sh` once and World grows from then on with nothing open; the system gets a sun; and `world.mjs` can say exactly what may leave the Mac.

**Architecture:** A launchd agent keeps `node server.mjs` running with `ACP_DAEMON=1`, which opens World at boot and waits politely when the port is taken. The sun is a renderer-only body placed from the seed. `publicProjection` is an allow-list copy of `summary()` and `validProjection` its mirror, both pure, both in `world.mjs` so the hub (slice 3) can import them.

**Tech Stack:** Node 20+ standard library, `node:test`, bash, launchd. No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-10-22-social-universe-design.md` (sections "Headless install", "The sun", "The public projection"). Everything else in `2026-10-21-world-design.md` still holds.

## Global Constraints

- Node standard library only; `package.json` keeps `"engines": {"node": ">=20"}`.
- No build step; `public/world.js` stays a plain IIFE that draws, `world.mjs` decides.
- One concern per module (`trust.mjs`, `versions.mjs` are the pattern); comments say what and why in plain sentences.
- Nothing hub- or daemon-related may sit on the request path or slow a scan.
- Private data never leaves `world.json` through the projection: no `earned, spent, balance, prices, today, home.xp, noEmail, gitFailed, moments[].info, builds[].description`, no exact timestamps, no hail purchases.
- The Mac app (`app/main.swift`) is not changed in these slices.
- Public repository: no personal paths or names in code, fixtures or docs.
- Tests: `node --test`, `process.env.TZ = 'UTC'` at the top of World tests, temp dirs from `fs.mkdtempSync(path.join(os.tmpdir(), '<name>-'))`.

## Review Focus

1. A repo path with `&`, `<` or a space in the plist must not break launchd; `launchdPlist` escapes XML and `plutil -lint` passes (Task 1).
2. An app-started server already holds the port when the daemon starts: the daemon must wait and take over, never crash-loop (Task 2, integration test).
3. `./install.sh` run twice must leave one loaded service, not two or an error (Task 3: bootout before bootstrap, ignoring a missing service).
4. A summary with no purchases and no frontier (a brand-new World) must project and validate; the sun must still sit inside the painted sky (Tasks 4–6: `extent()` includes the sun).
5. A hostile projection from a hub (slice 3 onward) must not reach the renderer: `validProjection` rejects every oversize, non-finite or off-list value and never returns the input object (Task 5).

---

## Slice 1: headless + launchd

### Task 1: `daemon.mjs`, the launchd agent as pure functions

**Files:**
- Create: `daemon.mjs`
- Test: `test/daemon.test.mjs`

**Interfaces:**
- Produces:
  - `LABEL(port: number): string` — `'local.agent-panel'` for 4747, else `'local.agent-panel.<port>'` (mirrors `app/build.sh:13-14`).
  - `plistPath(port, home = os.homedir()): string` — `<home>/Library/LaunchAgents/<LABEL>.plist`.
  - `logPath(port, home = os.homedir()): string` — `<home>/Library/Logs/Agent Panel/daemon-<port>.log`.
  - `launchdPlist({ label, node, repo, port, pathEnv, log }): string` — the plist XML.
  - `async install({ port, node, repo, pathEnv, home, run }): Promise<{ plist: string, label: string }>`.
  - `async remove({ port, home, run }): Promise<{ removed: boolean }>`.
  - `async status({ port, run }): Promise<{ loaded: boolean, pid: number | null }>`.
  - `run` is `(cmd: string, args: string[]) => Promise<{ stdout: string, stderr: string, err: Error | null }>`; the default wraps `execFile`.

- [ ] **Step 1: Write the failing tests**

```js
// test/daemon.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LABEL, plistPath, logPath, launchdPlist, install, remove, status } from '../daemon.mjs';

const uid = String(process.getuid());
const fakeRun = (answers = {}) => { const calls = []; const run = async (cmd, args) => { calls.push([cmd, ...args]); return answers[args[0]] ?? { stdout: '', stderr: '', err: null }; }; return Object.assign(run, { calls }); };

test('the label follows the app bundle id: plain on 4747, suffixed elsewhere', () => {
  assert.equal(LABEL(4747), 'local.agent-panel');
  assert.equal(LABEL(4800), 'local.agent-panel.4800');
  assert.equal(plistPath(4747, '/h'), '/h/Library/LaunchAgents/local.agent-panel.plist');
  assert.equal(logPath(4800, '/h'), '/h/Library/Logs/Agent Panel/daemon-4800.log');
});

test('the plist runs the server from the repo with PATH, the port and ACP_DAEMON, and launchd accepts it', () => {
  const xml = launchdPlist({ label: 'local.agent-panel', node: '/opt/node/bin/node', repo: '/tmp/a&b <c>', port: 4747, pathEnv: '/opt/node/bin:/usr/bin', log: '/tmp/d.log' });
  assert.match(xml, /<key>Label<\/key><string>local\.agent-panel<\/string>/);
  assert.match(xml, /<key>ProgramArguments<\/key><array><string>\/opt\/node\/bin\/node<\/string><string>\/tmp\/a&amp;b &lt;c&gt;\/server\.mjs<\/string><\/array>/);
  assert.match(xml, /<key>WorkingDirectory<\/key><string>\/tmp\/a&amp;b &lt;c&gt;<\/string>/);
  for (const [k, v] of [['PATH', '/opt/node/bin:/usr/bin'], ['ACP_PORT', '4747'], ['ACP_DAEMON', '1']]) assert.match(xml, new RegExp(`<key>${k}</key><string>${v.replace(/\//g, '\\/')}</string>`));
  for (const k of ['RunAtLoad', 'KeepAlive']) assert.match(xml, new RegExp(`<key>${k}</key><true/>`));
  assert.match(xml, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(xml, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.equal((xml.match(/<string>\/tmp\/d\.log<\/string>/g) ?? []).length, 2, 'stdout and stderr both go to the log');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-')), 'x.plist');
  fs.writeFileSync(f, xml);
  execFileSync('plutil', ['-lint', f]); // throws when launchd would refuse it
});

test('install writes the plist and the log folder, boots the old one out, then bootstraps the new', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-')), run = fakeRun();
  const r = await install({ port: 4747, node: '/usr/local/bin/node', repo: '/r', pathEnv: '/usr/bin', home, run });
  assert.equal(r.plist, plistPath(4747, home));
  assert.equal(r.label, 'local.agent-panel');
  assert.ok(fs.existsSync(r.plist));
  assert.ok(fs.existsSync(path.dirname(logPath(4747, home))));
  assert.deepEqual(run.calls, [['launchctl', 'bootout', `gui/${uid}/local.agent-panel`], ['launchctl', 'bootstrap', `gui/${uid}`, r.plist]]);
});

test('install succeeds when there was nothing to boot out', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-'));
  const run = fakeRun({ bootout: { stdout: '', stderr: 'Boot-out failed: 3: No such process', err: new Error('exit 3') } });
  await assert.doesNotReject(install({ port: 4747, node: '/n', repo: '/r', pathEnv: '/b', home, run }));
});

test('remove boots the service out and deletes the plist; a second remove reports nothing removed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-')), run = fakeRun();
  await install({ port: 4800, node: '/n', repo: '/r', pathEnv: '/b', home, run });
  assert.deepEqual(await remove({ port: 4800, home, run }), { removed: true });
  assert.equal(fs.existsSync(plistPath(4800, home)), false);
  assert.equal(run.calls.at(-1)[1], 'bootout');
  assert.deepEqual(await remove({ port: 4800, home, run }), { removed: false });
});

test('status reads the pid from launchctl print, and says not loaded when it fails', async () => {
  const up = fakeRun({ print: { stdout: 'local.agent-panel = {\n\tactive count = 1\n\tpid = 4242\n\tstate = running\n}', stderr: '', err: null } });
  assert.deepEqual(await status({ port: 4747, run: up }), { loaded: true, pid: 4242 });
  const down = fakeRun({ print: { stdout: '', stderr: 'Could not find service', err: new Error('exit 113') } });
  assert.deepEqual(await status({ port: 4747, run: down }), { loaded: false, pid: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/daemon.test.mjs`
Expected: FAIL, `Cannot find module '../daemon.mjs'`.

- [ ] **Step 3: Implement `daemon.mjs`**

Export the signatures above. `launchdPlist` escapes `&`, `<`, `>` in every string through one `esc()`; the XML is one `<dict>` with the keys the test checks, in that order: Label, ProgramArguments, WorkingDirectory, EnvironmentVariables (PATH, ACP_PORT, ACP_DAEMON), RunAtLoad, KeepAlive, ThrottleInterval, ProcessType, StandardOutPath, StandardErrorPath. `install` writes the plist with `mode 0o644` (`mkdirSync` its folder and the log folder, `recursive: true`), then `bootout gui/<uid>/<label>` ignoring any error, then `bootstrap gui/<uid> <plist>` and throws with `stderr` when that errs. `remove` boots out (ignore errors) and `unlinkSync`; `{ removed: false }` when the plist wasn't there. `status` runs `launchctl print gui/<uid>/<label>` and matches `/^\s*pid = (\d+)/m`. `uid` is `process.getuid()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/daemon.test.mjs`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add daemon.mjs test/daemon.test.mjs
git commit -m "feat(daemon): the launchd agent that keeps the panel running, as pure functions"
```

### Task 2: `cli.mjs`, the `ACP_DAEMON` server mode, and the port wait

**Files:**
- Create: `cli.mjs`
- Modify: `server.mjs:23` (argv dispatch after the imports), `server.mjs:24` (`DAEMON`), `server.mjs:1573-1580` (listen callback and an `error` handler)
- Test: `test/daemon-server.test.mjs`

**Interfaces:**
- Consumes: `daemon.mjs` (Task 1).
- Produces:
  - `cli.mjs`: `async main(argv: string[]): Promise<number>` handling `daemon install`, `daemon remove`, `daemon status`; prints one line per outcome; unknown command prints usage and returns 2. Reads `ACP_PORT` (default 4747), `process.execPath` for node, the repo from `import.meta.url`, `process.env.PATH`.
  - `server.mjs`: with argv beyond the script, imports `./cli.mjs` and exits with its code before any server side effect; `DAEMON = process.env.ACP_DAEMON === '1'`; under the daemon, World opens at boot and `EADDRINUSE` retries every 5 s instead of exiting.

- [ ] **Step 1: Write the failing integration test**

```js
// test/daemon-server.test.mjs
// The server as launchd runs it: ACP_DAEMON=1 opens World at boot and waits for a taken port. Spawns real processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import { spawn } from 'node:child_process';

const SERVER = new URL('../server.mjs', import.meta.url).pathname;
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };
const answers = (port) => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false);
function start(port, prefsDir, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ACP_PORT: String(port), ACP_PREFS: path.join(prefsDir, 'prefs.json'), ACP_DAEMON: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  return { child, log: () => out, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}

test('under ACP_DAEMON the server opens World at boot, with no button pressed', async (t) => {
  const port = await freePort(), prefs = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-'));
  const s = start(port, prefs); t.after(s.stop);
  assert.ok(await until(() => answers(port)), s.log());
  const file = path.join(prefs, 'world', 'world.json');
  assert.ok(await until(() => fs.existsSync(file)), 'world.json was not written');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2);
});

test('without ACP_DAEMON nothing is written until World is opened', async (t) => {
  const port = await freePort(), prefs = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-'));
  const s = start(port, prefs, { ACP_DAEMON: '' }); t.after(s.stop);
  assert.ok(await until(() => answers(port)), s.log());
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fs.existsSync(path.join(prefs, 'world', 'world.json')), false);
});

test('a taken port makes the daemon wait, not exit; it answers once the port frees up', async (t) => {
  const port = await freePort(), prefs = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-'));
  const holder = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => holder.once('listening', r));
  const s = start(port, prefs, { ACP_RETRY_MS: '300' }); t.after(s.stop);
  assert.ok(await until(() => /port \d+ is taken/.test(s.log())), s.log());
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.child.exitCode, null, 'it exited: ' + s.log());
  await new Promise((r) => holder.close(r));
  assert.ok(await until(() => answers(port)), s.log());
});

test('an argument runs the CLI instead of the server', async () => {
  const r = await new Promise((resolve) => { const c = spawn(process.execPath, [SERVER, 'nonsense'], { env: process.env }); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('exit', (code) => resolve({ code, out })); });
  assert.equal(r.code, 2);
  assert.match(r.out, /daemon install\|remove\|status/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/daemon-server.test.mjs`
Expected: FAIL. The first test times out on `world.json`; the third sees the process exit; the fourth gets exit code 0 or a running server.

- [ ] **Step 3: Implement `cli.mjs`**

`export async function main(argv)`: `const [cmd, sub] = argv`. For `daemon`: `install` → `install({ port, node: process.execPath, repo, pathEnv: process.env.PATH ?? '', run })` and print `Background service <label> installed (log: <logPath>)`; `remove` → print `Background service removed` or `No background service was installed`; `status` → print `Running (pid N)` / `Installed, not running` / `Not installed` (installed = plist exists). Return 0, or 1 when a launchctl call throws (print its message). Anything else prints `usage: node server.mjs daemon install|remove|status` to stderr and returns 2. `repo` = `path.dirname(fileURLToPath(import.meta.url))`.

- [ ] **Step 4: Change `server.mjs`**

After line 22's imports add:

```js
// `node server.mjs <command>` runs the CLI (cli.mjs) and never starts the server.
if (process.argv.length > 2) { const { main } = await import('./cli.mjs'); process.exit(await main(process.argv.slice(2))); }
```

Beside `PORT` (line 24): `const DAEMON = process.env.ACP_DAEMON === '1';` and `const RETRY_MS = Number(process.env.ACP_RETRY_MS ?? 5000);`.

Replace the `server.listen` call (1573-1580) so the callback also does `if (DAEMON && !world.started()) openWorld();` after the log line, and before it add:

```js
// Under launchd a server that quit on a taken port would be relaunched every 10 s forever. Wait instead: an app-started
// server from before the service was installed quits when the app does, and this one takes the port then.
server.on('error', (err) => {
  if (!(DAEMON && err.code === 'EADDRINUSE')) throw err;
  console.log(`port ${PORT} is taken; trying again in ${RETRY_MS / 1000} s`);
  setTimeout(() => server.listen(PORT, '127.0.0.1'), RETRY_MS);
});
```

Keep `server.listen(PORT, '127.0.0.1', cb)` as the one call site; `openWorld()` is the existing function at ~1354.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/daemon-server.test.mjs test/daemon.test.mjs`
Expected: all passing. Then `npm test`: everything green (95 + the new ones).

- [ ] **Step 6: Commit**

```bash
git add cli.mjs server.mjs test/daemon-server.test.mjs
git commit -m "feat(server): ACP_DAEMON opens World at boot and waits for a taken port; node server.mjs daemon ..."
```

### Task 3: `install.sh` installs the service; README and uninstall follow

**Files:**
- Modify: `install.sh` (flags, the daemon step, the Done text), `README.md:6-30` (Get started), `README.md:100-137` (Run it, Mac app), `README.md:359-362` (World's first sentence), `README.md:451-455` (Uninstall)

**Interfaces:**
- Consumes: `node server.mjs daemon install|remove|status` (Task 2).

- [ ] **Step 1: Write the check that will pass when the script is right**

There is no bash test harness; the check is `bash -n install.sh` plus a dry run. Add to the top of `install.sh` (after `cd`): argument parsing for `--no-daemon`, `--uninstall`, `--help`; anything else prints `usage: ./install.sh [--no-daemon | --uninstall]` and exits 2. Verify before implementing: `./install.sh --bogus; echo $?` prints the current script's checks instead of usage (exit 0 or 1).

- [ ] **Step 2: Implement the flags and the daemon step**

- `--uninstall` (bash only, before the dependency checks): `node server.mjs daemon remove` if `node` is on PATH, else `launchctl bootout gui/$UID/<label>` and `rm -f` the plist directly; `rm -rf "$out"` (the app, same path rule as line 49); then print the two manual steps (hook entries pointing at `127.0.0.1:<port>` in each profile's `settings.json`; `~/Library/Application Support/Agent Panel` and `~/Library/Logs/Agent Panel`). Exit 0.
- After `app/build.sh` (line 48), unless `--no-daemon`: `echo; echo "Installing the background service:"; node server.mjs daemon install` (it prints its own ok line), then wait up to 10 s for `curl -fsS "http://127.0.0.1:${ACP_PORT:-4747}/" >/dev/null`, printing `ok "The panel is running and World has started"` or `warn "The service hasn't answered yet; its log is ~/Library/Logs/Agent Panel/daemon-<port>.log"`.
- New Done text:

```
Done. The panel runs in the background from now on, also after a restart, and World grows from your sessions whether
or not you open it. Next:
  1. Open Agent Panel (<shown>, or Spotlight). macOS may ask whether it may use your Documents folder:
     the panel reads the repositories your sessions work in.
  2. If you use more than one Claude Code profile, pick yours under Profile, top right.
  3. Click Connect this profile. Sessions you start after that show up on the board.

Keep this folder where it is: the service runs the panel from here. After a git pull, run ./install.sh again: it
restarts the service on the new code (requests the panel was holding go back to their terminals for a moment).
./install.sh --no-daemon skips the service; ./install.sh --uninstall removes it and the app.
```

- [ ] **Step 3: Update the README**

- Get started (line 24-29): after step 3 add one sentence: "`install.sh` also installs a background service, so World keeps counting your work when the app isn't open; `./install.sh --no-daemon` skips it."
- Run it (100-109): add "Installed with `./install.sh`, the panel also runs as a launchd service (`local.agent-panel`, or `local.agent-panel.<port>` on another port): `launchctl print gui/$UID/local.agent-panel` shows it, `launchctl kickstart -k gui/$UID/local.agent-panel` restarts it, and its log is `~/Library/Logs/Agent Panel/daemon-<port>.log`. `node server.mjs daemon install|remove|status` manages it."
- Mac app (113-115): first bullet becomes "Opening it uses the background service's server, or any panel server already running, or starts one of its own (its log is …)."
- World (361): "World starts the first time you open it" → "World starts when the service is installed, or, without the service, the first time you open it".
- Uninstall (451-455): "Run `./install.sh --uninstall`: it removes the background service and `~/Applications/Agent Panel.app`. Then remove the hook entries that point at `127.0.0.1:4747` from each profile's settings, and delete `~/Library/Application Support/Agent Panel` and `~/Library/Logs/Agent Panel`."

- [ ] **Step 4: Verify**

Run: `bash -n install.sh && ./install.sh --bogus; echo "exit $?"`
Expected: `usage: ./install.sh [--no-daemon | --uninstall]` and `exit 2`.
Run: `./install.sh` (on the owner's Mac): the ok lines, then `launchctl print gui/$UID/local.agent-panel | grep pid` shows a pid, `ls ~/Library/Application\ Support/Agent\ Panel/world/world.json` exists (or did already). Open Agent Panel.app: `tail -3 ~/Library/Logs/Agent\ Panel/server-4747.log` gets no new "started the server" line. ⌘Q: `curl -s http://127.0.0.1:4747/ | head -c 40` still answers. `./install.sh` again: one service, new pid. `./install.sh --uninstall`: `launchctl print gui/$UID/local.agent-panel` says could not find service.

- [ ] **Step 5: Commit**

```bash
git add install.sh README.md
git commit -m "feat(install): the panel runs as a background service; --no-daemon and --uninstall"
```

---

## Slice 2: the sun and the public projection

### Task 4: `sunOf` and `daysActive` in `world.mjs`

**Files:**
- Modify: `world.mjs:49` (after `homeReach`), `world.mjs:72` (export `LOOKS`), `world.mjs:467` (`summary()`)
- Test: `test/world-universe.test.mjs`

**Interfaces:**
- Produces:
  - `export const SUN_DIST = 90, SUN_R = 9, SUN_LOOKS = ['gold', 'white', 'orange', 'blue']`.
  - `export function sunOf(seed: number): { x: number, y: number, r: number, look: string }` — at angle `2π·hash(seed, 'sun')`, distance `SUN_DIST`, look `SUN_LOOKS[floor(hash(seed, 'sun look') · 4)]`. Must be defined below `hash` (line 67).
  - `export const LOOKS` (was `const`).
  - `summary()` gains `sun: sunOf(st.seed)` and `daysActive: number` (days in `daysOf()` with `dayCredit > 0`).

- [ ] **Step 1: Write the failing tests**

```js
// test/world-universe.test.mjs
// The sun beside Home, days active, and what of World may leave this Mac. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, sunOf, SUN_DIST, SUN_R, SUN_LOOKS, LOBE_START, PUSH_LEN } from '../world.mjs';

const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 12, 9, 0), at = (d) => T0 + d * DAY;
const key = (ms) => new Date(ms).toISOString().slice(0, 10), credit = (c) => c * 10_000;
const push = (ang, earnedAt = 0) => ({ kind: 'frontier', at: at(0), price: 4000, earnedAt, ang });
function seeded({ tokens = { [key(at(0))]: credit(30_000) }, lines = {}, purchases = [push(0)], now = at(0), extra = {} } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens, lines, repos: [], purchases, ...extra }));
  const make = () => createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => now });
  return { world: make(), file, reload: make };
}

test('the sun sits SUN_DIST from Home, the same every time for a seed, and differs between seeds', () => {
  const s = sunOf(7);
  assert.deepEqual(s, sunOf(7));
  assert.ok(Math.abs(Math.hypot(s.x, s.y) - SUN_DIST) < 1e-9);
  assert.equal(s.r, SUN_R);
  assert.ok(SUN_LOOKS.includes(s.look));
  assert.notDeepEqual([s.x, s.y], [sunOf(8).x, sunOf(8).y]);
});

test('the sun is closer than any planet the frontier can find', () => {
  assert.ok(SUN_DIST + SUN_R < LOBE_START + 0.55 * PUSH_LEN - 18, 'planets start past LOBE_START + 0.55·PUSH_LEN, off by up to 18');
});

test("summary() carries the sun and the days with work in them", () => {
  const { world, reload } = seeded({ tokens: { [key(at(0))]: credit(30), [key(at(1))]: 0, [key(at(3))]: credit(1) }, now: at(3) });
  const s = world.summary();
  assert.deepEqual(s.sun, sunOf(7));
  assert.equal(s.daysActive, 2);
  assert.deepEqual(reload().summary().sun, s.sun);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/world-universe.test.mjs`
Expected: FAIL, `sunOf` is not exported.

- [ ] **Step 3: Implement in `world.mjs`**

Add the constants and `sunOf` right after `toMap`/`hash` (line 68 area) with a comment: "The star Home orbits: near Home, inside its light, never where a planet can be." Change line 72 to `export const LOOKS`. In `summary()` add `sun: sunOf(st.seed)` and `daysActive: Object.values(days).filter((x) => dayCredit(x) > 0).length` to `s`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/world-universe.test.mjs` then `npm test`.
Expected: all passing; the existing World tests are unaffected because they never `deepEqual` the whole summary.

- [ ] **Step 5: Commit**

```bash
git add world.mjs test/world-universe.test.mjs
git commit -m "feat(world): a sun beside Home, placed by the seed, and the count of days with work"
```

### Task 5: `publicProjection` and `validProjection`

**Files:**
- Modify: `world.mjs` (new section after `colonyName`, line 155; export `SUN_LOOKS`, `LOOKS` already from Task 4)
- Test: `test/world-projection.test.mjs`

**Interfaces:**
- Produces:
  - `export const PROJECTION_VERSION = 1`.
  - `export function publicProjection(s): object | null` — `null` unless `s?.started`; else exactly
    `{ pv, seed, since, daysActive, home: { level, stage }, reach, sun: { x, y, r, look }, frontier: [{ ang, bought, lit, tip }], planets: [{ id, x, y, look, colony: { name, day } | null }], moments: [{ id, kind, name, day, from?, x, y }], builds: [{ id, on, caption, pieces, day }] }`, with `since = dayKey(s.startedAt)`, colony `day = dayKey(colony.at)`, build `day = dayKey(at)`, `from` present only when the moment has one.
  - `export function validProjection(p): object | null` — a fresh object with the same keys, or `null`. Limits: `pv === 1`; `seed` integer in `[0, 2^31)`; `since`, every `day`, `from` match `/^\d{4}-\d{2}-\d{2}$/`; `daysActive` integer `0..100000`; `home.level` integer `1..LEVELS.length` and `home.stage` is replaced by `LEVELS[level-1][1]`; `reach` finite `0..1e6`; `sun.x/y` finite `|v| ≤ 1e6`, `sun.r` finite `0..1e3`, `sun.look ∈ SUN_LOOKS`; `frontier ≤ 64` items of finite numbers (`ang` in `[-π, π]`, others `0..1e6`); `planets ≤ 256`, `id` `/^p\d{1,4}$/` unique, `look ∈ LOOKS`, `colony` null or `{ name: colonyName(name) ?? reject, day }`; `moments ≤ 4000`, `id` string ≤ 40, `kind ∈ ['week','cleanup','level']`, `name` string ≤ 80, `x/y` finite; `builds ≤ 1000`, `id` `/^b\d{1,4}$/`, `on === 'home'` or a planet id in `planets`, `{ caption, pieces }` through `validBuild`. Every value is copied, never spread, like `validBuild`.

- [ ] **Step 1: Write the failing tests**

```js
// test/world-projection.test.mjs
// What of World may leave this Mac: the shape of the system, never the numbers that paid for it. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, publicProjection, validProjection, PROJECTION_VERSION, LEVELS } from '../world.mjs';

const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 12, 9, 0), at = (d) => T0 + d * DAY, key = (ms) => new Date(ms).toISOString().slice(0, 10);
// The same fixture as test/world-universe.test.mjs (each World test file carries its own, as the existing ones do).
function seeded({ tokens = {}, lines = {}, purchases = [], now = at(0), extra = {} } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens, lines, repos: [], purchases, ...extra }));
  return { world: createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => now }) };
}
const PUSH = { kind: 'frontier', at: at(0), price: 4000, earnedAt: 0, ang: 0 };
const ROCKET = { kind: 'rocket', at: at(1), price: 8000, earnedAt: 0, planet: 'p0', name: 'Vesta' };
const BUILD = { kind: 'build', at: at(2), price: 4000, earnedAt: 0, on: 'home', description: 'a SECRET-PROMPT about my-private-repo', caption: 'A ring city', pieces: [{ kind: 'ring_city', colour: '#ffc56a', size: 'large', place: 'equator', count: 4 }] };
const HAIL = { kind: 'hail', at: at(2), price: 2000, earnedAt: 0, to: { handle: 'kim' } };
/** A World with a push, a colony, a build, a cleanup day, a finished week, repos git couldn't read, over three weeks. */
function rich() {
  const tokens = {}, lines = { '/Users/someone/my-private-repo': {} };
  for (let d = 0; d < 21; d++) { tokens[key(at(d))] = 2_000_000; lines['/Users/someone/my-private-repo'][key(at(d))] = { added: 300, removed: d === 4 ? 2000 : 20, commits: 3 }; }
  return seeded({ tokens, lines, purchases: [PUSH, ROCKET, BUILD, HAIL], now: at(21), extra: { noEmail: ['/Users/someone/other-repo'], gitFailed: ['/Users/someone/slow-repo'] } }).world.summary();
}
const PRIVATE = ['earned', 'spent', 'balance', 'prices', 'today', 'xp', 'noEmail', 'gitFailed', 'description', 'info', 'tokens', 'added', 'removed', 'commits', 'credit', 'startedAt', '"at"', 'hail', 'kim', '/Users', 'my-private-repo', 'SECRET'];

test('the projection has exactly the public keys and nothing private in its text', () => {
  const s = rich(), p = publicProjection(s), text = JSON.stringify(p);
  assert.deepEqual(Object.keys(p), ['pv', 'seed', 'since', 'daysActive', 'home', 'reach', 'sun', 'frontier', 'planets', 'moments', 'builds']);
  assert.deepEqual(Object.keys(p.home), ['level', 'stage']);
  for (const word of PRIVATE) assert.equal(text.includes(word), false, `leaks ${word}`);
  assert.equal(p.pv, PROJECTION_VERSION);
  assert.equal(p.since, '2026-10-12');
  assert.equal(p.daysActive, 21);
  assert.deepEqual(p.planets[0].colony, { name: 'Vesta', day: '2026-10-13' });
  assert.deepEqual(p.builds, [{ id: 'b0', on: 'home', caption: 'A ring city', pieces: BUILD.pieces, day: '2026-10-14' }]);
  assert.ok(p.moments.some((m) => m.kind === 'cleanup') && p.moments.some((m) => m.kind === 'week'), 'moments kept, by kind');
  assert.deepEqual(Object.keys(p.moments.find((m) => m.kind === 'week')), ['id', 'kind', 'name', 'day', 'from', 'x', 'y']);
  assert.deepEqual(Object.keys(p.moments.find((m) => m.kind === 'cleanup')), ['id', 'kind', 'name', 'day', 'x', 'y']);
  assert.equal(publicProjection({ started: false }), null);
  assert.equal(publicProjection(undefined), null);
});

test('a brand-new World projects: no purchases, no frontier, level 1', () => {
  const p = publicProjection(seeded({ tokens: {}, purchases: [] }).world.summary());
  assert.deepEqual([p.home, p.frontier, p.planets, p.builds, p.daysActive], [{ level: 1, stage: 'Bare rock' }, [], [], [], 0]);
  assert.deepEqual(validProjection(p), p);
});

test('the projection is deterministic and round-trips through the validator unchanged', () => {
  const s = rich(), a = publicProjection(s), b = publicProjection(s);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const v = validProjection(JSON.parse(JSON.stringify(a)));
  assert.deepEqual(v, a);
  assert.notEqual(v, a, 'a fresh object, never the input');
});

test('the validator refuses what the renderer must never see', () => {
  const good = publicProjection(rich()), copy = () => JSON.parse(JSON.stringify(good));
  const bad = (mutate, why) => { const p = copy(); mutate(p); assert.equal(validProjection(p), null, why); };
  bad((p) => { p.extra = 1; }, 'an extra key');
  bad((p) => { p.pv = 2; }, 'another version');
  bad((p) => { p.seed = 2 ** 31; }, 'seed out of range');
  bad((p) => { p.seed = 1.5; }, 'seed not an integer');
  bad((p) => { p.since = '2026-1-1'; }, 'a malformed day');
  bad((p) => { p.home.level = LEVELS.length + 1; }, 'a level past the ladder');
  bad((p) => { p.home.level = 0; }, 'level 0');
  bad((p) => { p.sun.look = 'green'; }, 'a sun look off the list');
  bad((p) => { p.sun.x = Infinity; }, 'a non-finite coordinate');
  bad((p) => { p.planets[0].x = NaN; }, 'NaN');
  bad((p) => { p.planets[0].x = 1e7; }, 'a coordinate past 1e6');
  bad((p) => { p.planets[0].look = 'lava'; }, 'a planet look off the list');
  bad((p) => { p.planets[0].colony.name = 'x'.repeat(25); }, 'a 25-letter colony name');
  bad((p) => { p.planets[0].id = 'q0'; }, 'a bad planet id');
  bad((p) => { p.planets.push({ ...p.planets[0] }); }, 'a duplicate planet id');
  bad((p) => { p.builds[0].on = 'p9'; }, 'a build on a planet that is not there');
  bad((p) => { p.builds[0].pieces[0].kind = 'volcano'; }, 'a piece off the catalogue');
  bad((p) => { p.builds = Array.from({ length: 1001 }, (_, i) => ({ ...p.builds[0], id: `b${i}` })); }, '1001 builds');
  bad((p) => { p.frontier = Array.from({ length: 65 }, () => p.frontier[0] ?? { ang: 0, bought: 150, lit: 0, tip: 60 }); }, '65 lobes');
  bad((p) => { p.moments[0].kind = 'secret'; }, 'a moment kind off the list');
  bad((p) => { p.moments[0].info = { credit: 1 }; }, 'a moment carrying info');
  assert.equal(validProjection(null), null);
  assert.equal(validProjection('{}'), null);
  const relabeled = copy(); relabeled.home.stage = 'Paradise';
  assert.equal(validProjection(relabeled).home.stage, LEVELS[good.home.level - 1][1], 'the stage is re-derived from the level');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/world-projection.test.mjs`
Expected: FAIL, `publicProjection` is not exported.

- [ ] **Step 3: Implement in `world.mjs`**

New section `// ---- what may leave this Mac` after `colonyName`. `publicProjection` builds the object key by key in the order the test asserts; moments are copied with `from` only when `m.from !== undefined`. `validProjection` uses small local helpers: `num(v, lo, hi)`, `int(v, lo, hi)`, `day(v)`, `str(v, max)`; returns `null` at the first failure; builds the fresh object in the same key order; checks `Object.keys(p)` equals the allow-list exactly (so an extra key fails) and the same for `home`, `sun`, each planet, moment and build (`from` optional). Use the exported `LEVELS`, `LOOKS`, `SUN_LOOKS`, `colonyName`, `validBuild`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/world-projection.test.mjs` then `npm test`.
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add world.mjs test/world-projection.test.mjs
git commit -m "feat(world): the public projection of a system, and the validator a hub and the page trust"
```

### Task 6: the sun in `world.js`, and a read-only mode

**Files:**
- Modify: `public/world.js:19-24` (constants), `:51` (`days()`), `:58-82` (`lit`, `extent`, `paint`), `:101-174` (`drawHome` lighting), `:178-202` (`drawPlanet` lighting), `:231-234` (`drawBuilt` daylight), `:304-306` (city lights night side), `:358-428` (`frame`: draw the sun), `:680-712` (`show` tolerates a projection), `:714-735` (`enter`/`update` options)
- No automated test: canvas drawing. Manual verification below.

**Interfaces:**
- Consumes: `summary.sun = { x, y, r, look }` (Task 4); a projection's `home = { level, stage }` without `xp` (Task 5).
- Produces: `AgentWorld.enter(summary, { api, toast, readOnly })`: with `readOnly`, the spend boxes (`w-build-box`, `w-rocket-box`, `w-push-box`) and `w-today`'s section are hidden and `show()` never reads `balance`, `today`, `prices`, `earned`, `startedAt` or `home.xp` without a fallback. Slice 3's hub page relies on this.

- [ ] **Step 1: The sun on the map**

Constants: `const SUN = { gold: '#ffd27a', white: '#eef2ff', orange: '#ffa65c', blue: '#bcd3ff' };` and `const sun = () => world?.sun ?? null;`. `extent()` gains `...(sun() ? [Math.hypot(sun().x, sun().y) + 70] : [])`. `lit()` gains, when `sun()`, `best = Math.max(best, 1 - Math.hypot(mx - sun().x, my - sun().y) / 70)`. `paint()`'s `sig` includes `world?.sun`. New `drawSun(px, py, r, t)`: a radial gradient corona from `rgba(colour, .35)` at `r` to transparent at `3r`, the disc in `SUN[look]`, and six rays (`x.lineWidth = 1`, alpha `.18`, length `2.2r`, rotated by `t / 20000` unless `calm.matches`). Call it in `frame()` inside the `mapA > 0` block after the stars and before the lobes' trails, at `to(sun().x, sun().y)` with `r = Math.max(2.5, sun().r * s)`.

- [ ] **Step 2: Light from the sun's side close up**

In `frame()`, once per frame: `const sa = sun() ? Math.atan2(sun().y, sun().x) : Math.PI * 1.25, lx = Math.cos(sa), ly = Math.sin(sa);` stored on a module-level `light = { lx, ly }` (default: the old top-left). Then:
- `drawHome` line 142: gradient centre `cx + light.lx * R * 0.45, cy + light.ly * R * 0.4`.
- `drawHome` line 150: `night = (lx - cx) * light.lx + (ly - cy) * light.ly < -R * 0.05`.
- `drawPlanet` line 185: `cx + light.lx * R * 0.35, cy + light.ly * R * 0.35`.
- `drawBuilt` line 234: `lit = (sx, sy) => clamp(1.25 - Math.hypot(sx - (cx + light.lx * 0.45 * R), sy - (cy + light.ly * 0.4 * R)) / (1.5 * R), 0.25, 1)`.
- `drawBuilt` line 305: `night = (s.x - cx) * light.lx + (s.y - cy) * light.ly < -R * 0.05`.
- A warm off-canvas glow when `detail > 0`: a radial gradient centred at `hx + light.lx * viewMin * 0.9, hy + light.ly * viewMin * 0.9`, radius `viewMin * 0.7`, from `rgba(SUN[look] at .18 * detail)` to transparent, drawn before Home.

- [ ] **Step 3: Read-only mode and a projection's Home**

`const LEVEL_XP = [0, 15, 100, 300, 500, 800, 1200, 1600, 2000, 2600, 3300, 4000];` (world.mjs `LEVELS`, for a projection without xp). `days()` becomes `((world?.home?.xp ?? LEVEL_XP[(world?.home?.level ?? 1) - 1]) / 100)`. In `enter`, `document.body.classList.toggle('w-readonly', Boolean(opts.readOnly))`; add to `public/index.html`'s World CSS: `body.w-readonly #w-build-box, body.w-readonly #w-rocket-box, body.w-readonly #w-push-box, body.w-readonly #w-today-box, body.w-readonly #w-total-box { display: none }`, giving the Today's work section (index.html:878) `id="w-today-box"` and the last section (883) `id="w-total-box"`. In `show()`: `$('w-xp').hidden = h.xp == null`, bars use `h.xp ?? h.at ?? 0`; `$('w-credit').textContent = fmt(Math.max(0, w.balance ?? 0))`; the `today` rows, `w-total` and the notes run only when `!opts.readOnly`; `showPush/showBuild/showRocket/showColonies` return early when `opts.readOnly`.

- [ ] **Step 4: Verify by hand**

Run: `node server.mjs` and open `http://127.0.0.1:4747`, open World.
Expected: on the map a sun with a corona and slow rays near Home, inside the lit area, never on a planet; the map fits it (`Map` shows the whole lit area with the sun). Close up, Home's bright side faces where the sun sits on the map and city lights come on on the far side; colonies likewise; a warm glow at the edge of the view in the sun's direction. With System Settings → Accessibility → Reduce motion on, the rays stand still. For the read-only check, temporarily add `window.__world = summary;` as the first line of `enter()`, reload, open World, then in the console run `AgentWorld.enter({ ...window.__world, home: { level: 7, stage: 'Settlements' } }, { api: async () => ({ ok: false }), toast: () => {}, readOnly: true })`: a level-7 Home draws (settlements, lights at night) and the Build, Push, Rocket and Today's work boxes are gone. Remove the temporary line before committing. `npm test` still green.

- [ ] **Step 5: Commit**

```bash
git add public/world.js public/index.html
git commit -m "feat(world): the sun lights the system, and the view can show a system read-only"
```

### Task 7: README for the sun

**Files:**
- Modify: `README.md:359-362` (World intro)

- [ ] **Step 1: Write it**

After the first paragraph of the World section add: "Beside Home sits its **sun**, placed by your world's seed: it lights Home's day side and the colonies', and marks your system on the map."

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(world): the sun"
```

## Verification for the whole plan

- `npm test`: every suite green, including `daemon`, `daemon-server`, `world-universe`, `world-projection`.
- Review Focus 1–5 are pinned by: Task 1 (escaping + `plutil -lint`), Task 2 (taken-port test), Task 3 (manual double install), Task 5 (brand-new World test; validator tests), Task 6 (`extent()` includes the sun, checked by eye on the map).
- On the owner's Mac: Task 3's manual sequence once, end to end.
