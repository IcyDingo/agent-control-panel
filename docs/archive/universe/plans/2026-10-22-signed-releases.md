# Signed Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker installs, and the hub serves, only a release the owner signed with a key that lives on the owner's Mac, and nothing can ever move a worker or the hub to an older release.

**Architecture:** One shared module at the repo root, `release-keys.mjs`, holds the public keys and the verify/sign primitives; the hub (`hub/config.mjs`), the deploy script (`hub/deploy/update.sh`, through a `node:22-alpine` container) and the worker (`update.mjs`) all call it. The owner's tool `tools/release.mjs` makes an encrypted Ed25519 key and signs `<n> <sha>`, where `n` is the commit count on `main`, so releases are ordered and a lower `n` is refused everywhere.

**Tech Stack:** Node stdlib only (`node:crypto` Ed25519, `node:test`), POSIX sh, Docker on the server.

**Spec:** `docs/superpowers/specs/2026-10-22-signed-releases-design.md`

## Global Constraints

- No npm dependencies; Node 20 for the Mac side, Node 22 for the hub (`node:sqlite`).
- Every test file is `test/<name>.test.mjs` under `node:test`; `npm test -s` must stay green after every task.
- The signed message is the UTF-8 bytes of `` `${n} ${sha}` `` (one space). `n` is a positive integer, the sha 40 lower-case hex.
- A signature is 64 bytes, carried as **base64url without padding**. Several are joined with `,` in `HUB_RELEASE_SIG` and on the `update.sh` command line, and carried as a JSON array `sigs` in `/api/release`.
- `RELEASE_KEYS` entries are the raw 32-byte Ed25519 public key as standard base64 (44 chars). The Ed25519 SPKI DER prefix is `302a300506032b6570032100`; a raw key is DER's last 32 bytes.
- The private key is at `~/.config/agent-panel/signing-key.pem` (more keys: `signing-key-2.pem`, `-3`, …), PKCS8 PEM encrypted with `aes-256-cbc`, mode 0600. `ACP_SIGNING_KEY` names another folder. `ACP_SIGNING_PASSPHRASE` supplies the passphrase (tests only; the tool otherwise asks without echo).
- Exact sentences: hub `This hub's release is not signed by a known key.`; hub (unchanged) `This hub does not name a release yet.`; worker `Release <7> is not signed by a known key.` and `Release <7> is older than the one running.`; deploy `This hub serves signed releases: run  node tools/release.mjs sign  on your Mac and use the line it prints.` (`<7>` is the sha's first 7 characters.)
- Frozen formats stay frozen: the worker's `switch` file and the `launcher.sh` that reads it are not touched.
- Commits carry `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (a subagent names the model that wrote the commit). Never run `./install.sh`, `hub/public/install.sh` or `node server.mjs daemon install` for real on this Mac.
- The private key, a passphrase, or `.env` never appear in a test fixture committed to the repo, a log line, or a printed command.

## Review Focus

1. `/api/release` with `n` as a string (`"12"`), a float, or `sigs` not an array: the worker must refuse it as unsigned, never throw. Pinned in Task 5.
2. `HUB_RELEASE_SIG` with spaces or a trailing comma, as a hand edit leaves it: the hub trims and drops empty entries, and still verifies. Pinned in Task 3.
3. The worker's `release` file corrupt or half written (`garbage`, one field): treated as absent, never a crash, and the next switch rewrites it. Pinned in Task 5.
4. `update.sh <sha> <n> <sigs>` with `n` that is not a number, or a sha that is not 40 hex: refused before any `git fetch`, `docker` or write. Pinned in Task 4.
5. `keygen` with an empty passphrase, or two passphrases that differ: refused, no file written. Pinned in Task 2.

---

### Task 1: `release-keys.mjs`, the shared keys and primitives

**Files:**
- Create: `release-keys.mjs`
- Test: `test/release-keys.test.mjs`

**Interfaces:**
- Produces:
  - `export const RELEASE_KEYS = []` (the owner pastes the first key after running `keygen`; a comment line per key with the date added).
  - `export const SHA_RE = /^[0-9a-f]{40}$/` (the same regex `update.mjs` has; `update.mjs` keeps its own, Task 5 does not rewire it).
  - `export function releaseMessage(n, sha) → string` (`` `${n} ${sha}` ``).
  - `export function validN(n) → boolean` (`Number.isInteger(n) && n >= 1 && n <= 2 ** 31`).
  - `export function verifyRelease(n, sha, sigs, keys = RELEASE_KEYS) → boolean`: false unless `validN(n)`, `SHA_RE.test(sha)`, `sigs` is a non-empty array of strings and `keys` non-empty; true when any sig verifies under any key; a malformed sig or key is false for that pair, never a throw.
  - `export function signRelease(n, sha, privateKey) → string` (base64url, `crypto.sign(null, Buffer.from(releaseMessage(n, sha)), privateKey)`).
  - `export function rawPublicKey(publicKey) → string` (base64 of the SPKI DER's last 32 bytes).
  - `export function publicKeyObject(raw) → KeyObject` (`createPublicKey({ key: Buffer.concat([PREFIX, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' })`).
  - CLI: `node release-keys.mjs verify <sha> <n> <sigs>` exits 0 when `verifyRelease` is true, 1 otherwise, prints nothing. Main-module detection: `import.meta.url === pathToFileURL(process.argv[1] ?? '').href`.

- [ ] **Step 1: Write the failing tests**

```js
// test/release-keys.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { releaseMessage, validN, verifyRelease, signRelease, rawPublicKey, publicKeyObject } from '../release-keys.mjs';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const pair = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { pub: rawPublicKey(publicKey), privateKey }; };

test('the message is "<n> <sha>" and n must be a positive integer', () => {
  assert.equal(releaseMessage(12, SHA), `12 ${SHA}`);
  for (const n of [1, 12, 2 ** 31]) assert.equal(validN(n), true, String(n));
  for (const n of [0, -1, 1.5, '7', NaN, Infinity, null, undefined, 2 ** 31 + 1]) assert.equal(validN(n), false, String(n));
});

test('a signature by a listed key verifies; one good among bad ones is enough, under any listed key', () => {
  const a = pair(), b = pair();
  const sigA = signRelease(12, SHA, a.privateKey), sigB = signRelease(12, SHA, b.privateKey);
  assert.equal(sigA.length, 86, 'base64url of 64 bytes, no padding');
  assert.equal(verifyRelease(12, SHA, [sigA], [a.pub]), true);
  assert.equal(verifyRelease(12, SHA, ['x'.repeat(86), sigB], [a.pub, b.pub]), true, 'a bad one first, a good one under the second key');
  assert.equal(verifyRelease(12, SHA, [sigA, sigB], [b.pub]), true, 'the key list need not know every signer');
});

test('a wrong key, sha, n, signature, or an empty list is refused and never throws', () => {
  const a = pair(), b = pair();
  const sig = signRelease(12, SHA, a.privateKey);
  assert.equal(verifyRelease(12, SHA, [sig], [b.pub]), false, 'wrong key');
  assert.equal(verifyRelease(12, OTHER, [sig], [a.pub]), false, 'wrong sha');
  assert.equal(verifyRelease(13, SHA, [sig], [a.pub]), false, 'the same sha with n+1');
  for (const n of [0, -1, 1.5, '12']) assert.equal(verifyRelease(n, SHA, [sig], [a.pub]), false, `n ${n}`);
  assert.equal(verifyRelease(12, SHA, [sig.slice(0, 40)], [a.pub]), false, 'truncated');
  assert.equal(verifyRelease(12, SHA, [sig.replace(/./g, '+')], [a.pub]), false, 'not base64url');
  assert.equal(verifyRelease(12, SHA, [], [a.pub]), false, 'no signatures');
  assert.equal(verifyRelease(12, SHA, [sig], []), false, 'no keys');
  assert.equal(verifyRelease(12, SHA, sig, [a.pub]), false, 'sigs must be an array');
  assert.equal(verifyRelease(12, SHA, [sig], ['not a key']), false, 'a malformed key is skipped');
  assert.equal(verifyRelease(12, 'A'.repeat(40), [sig], [a.pub]), false, 'lower-case hex only');
});

test('a raw public key round-trips through a KeyObject', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = rawPublicKey(publicKey);
  assert.equal(Buffer.from(raw, 'base64').length, 32);
  assert.equal(rawPublicKey(publicKeyObject(raw)), raw);
  assert.equal(verifyRelease(1, SHA, [signRelease(1, SHA, privateKey)], [raw]), true);
});

test('the command line verifies with the keys in the file: exit 1 for an unknown key, nothing printed', () => {
  const a = pair();
  const sig = signRelease(12, SHA, a.privateKey);
  // RELEASE_KEYS in the repo cannot hold a test key, so only the refusal is checked here; Task 4 covers a passing verify
  // through an injected keys file.
  assert.throws(() => execFileSync('node', ['release-keys.mjs', 'verify', SHA, '12', sig], { stdio: 'pipe' }), (e) => e.status === 1 && e.stdout.length === 0);
  assert.throws(() => execFileSync('node', ['release-keys.mjs', 'verify', SHA, 'x', sig], { stdio: 'pipe' }), (e) => e.status === 1);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/release-keys.test.mjs`
Expected: FAIL, `Cannot find module '…/release-keys.mjs'`.

- [ ] **Step 3: Write `release-keys.mjs`**

A header comment that says what the file is (the public keys every hub and worker trusts, and the one way a release is signed and checked), the Interfaces above, and the `verify` CLI. `RELEASE_KEYS` starts empty with a comment showing the shape of an entry (`// 'base64…', // added 2026-10-22`). `ACP_RELEASE_KEYS_FILE`, when set, replaces `RELEASE_KEYS` for the CLI only: it names a JSON file holding an array of raw keys (Task 4's test uses it; the hub and the worker never read it).

- [ ] **Step 4: Run the tests**

Run: `node --test test/release-keys.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add release-keys.mjs test/release-keys.test.mjs
git commit -m "feat(release): the shared keys module: Ed25519 over \"<n> <sha>\", any listed key, a verify command"
```

---

### Task 2: `tools/release.mjs`, the owner's `keygen` and `sign`

**Files:**
- Create: `tools/release.mjs`
- Test: `test/release-tool.test.mjs`

**Interfaces:**
- Consumes: Task 1's `signRelease`, `rawPublicKey`, `SHA_RE`.
- Produces (exported for tests, used by the CLI):
  - `export function keyDir(env = process.env) → string` (`env.ACP_SIGNING_KEY || path.join(os.homedir(), '.config', 'agent-panel')`).
  - `export function keyFiles(dir) → string[]` (`signing-key.pem`, `signing-key-2.pem`, … sorted by that number; only names matching `/^signing-key(-\d+)?\.pem$/`).
  - `export function keygen({ dir, passphrase }) → { file, publicKey }`: refuses an empty passphrase (`throw new Error('A passphrase is required.')`), makes `dir` with mode 0700, writes the next free name with mode 0600 (`writeFileSync(file, pem, { mode: 0o600, flag: 'wx' })`), PEM from `privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase })`.
  - `export function loadKey(file, passphrase) → KeyObject`: refuses a file whose mode is not 0600 (`Error('<file> must be mode 0600.')`); `createPrivateKey({ key, passphrase })`; a wrong passphrase surfaces as `Error('The passphrase did not open <file>.')`.
  - `export async function sign({ sha, dir, passphrase, cwd = process.cwd(), run }) → { sha, n, sigs }`: `run` is `(cmd, args) → Promise<{ err, stdout, stderr }>` like the tests' helper. Refuses a dirty tree (`git status --porcelain` not empty → `Error('The working tree has changes; commit or discard them first.')`), a sha that is not an ancestor of `origin/main` (`git merge-base --is-ancestor <sha> origin/main` non-zero → `Error('<7> is not on origin/main; push it first.')`), and no key files (`Error('No signing key; run  node tools/release.mjs keygen  first.')`). `n` is `Number(stdout)` of `git rev-list --count <sha>`. Signs with every key file.
  - `export function printed({ sha, n, sigs, host, dir = '/srv/agent-hub' }) → string[]`: exactly `HUB_RELEASE=<sha>`, `HUB_RELEASE_N=<n>`, `HUB_RELEASE_SIG=<sigs joined by ,>`, `ssh <host> <dir>/update.sh <sha> <n> <sigs>` (host `<host>` literally when none is known).
  - CLI `main(argv)`: `keygen` asks the passphrase twice (no echo) and refuses when they differ (`The passphrases differ.`), prints `Public key: <raw>`, `Paste it into RELEASE_KEYS in release-keys.mjs, then commit.` and `Back the file up: <file>. Without it and its passphrase no release can be signed; losing it means re-installing every worker.`; `sign [sha] [--deploy <user@host[:dir]>]`: sha defaults to `git rev-parse HEAD`; host from the flag or `ACP_RELEASE_HOST`; when `ACP_HUB` is set it fetches `<ACP_HUB>/api/release` (4 s timeout) and prints `Since the release the hub serves (<7>):` followed by `git log --oneline <served>..<sha>` (skipped silently when unreachable or unsigned); with `--deploy` it runs the ssh line through `run('ssh', […])` and exits with its code. Exit 0 done, 1 refused.
  - Passphrase prompt: `ACP_SIGNING_PASSPHRASE` when set; otherwise `readline` on a TTY with the echo muted (`rl._writeToOutput = () => {}` after the prompt); a non-TTY stdin without the variable is `Error('No terminal to ask the passphrase on; set ACP_SIGNING_PASSPHRASE.')`.

- [ ] **Step 1: Write the failing tests**

```js
// test/release-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { verifyRelease } from '../release-keys.mjs';
import { keyDir, keyFiles, keygen, loadKey, sign, printed } from '../tools/release.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-')));
const run = (cmd, args, opts = {}) => new Promise((resolve) =>
  execFile(cmd, args, opts, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** A repo with two commits on main pushed to a bare origin, and a third commit that is not pushed. */
function repo() {
  const origin = tmp(), cwd = tmp();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com'); git(cwd, 'config', 'user.name', 'T');
  const commit = (msg) => { fs.writeFileSync(path.join(cwd, 'f'), msg); git(cwd, 'add', 'f'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
  const first = commit('one'), second = commit('two');
  git(cwd, 'remote', 'add', 'origin', origin); git(cwd, 'push', '-q', '-u', 'origin', 'main');
  const unpushed = commit('three');
  return { cwd, first, second, unpushed };
}

test('keygen writes an encrypted 0600 PEM under the next free name and prints a key that verifies', () => {
  const dir = path.join(tmp(), 'keys');
  const a = keygen({ dir, passphrase: 'pw' });
  assert.equal(a.file, path.join(dir, 'signing-key.pem'));
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(a.file, 'utf8'), /ENCRYPTED PRIVATE KEY/);
  const b = keygen({ dir, passphrase: 'pw2' });
  assert.equal(b.file, path.join(dir, 'signing-key-2.pem'), 'a second key gets a new file');
  assert.deepEqual(keyFiles(dir), [a.file, b.file]);
  const sha = 'c'.repeat(40);
  const { signRelease } = await import('../release-keys.mjs');
  assert.equal(verifyRelease(1, sha, [signRelease(1, sha, loadKey(a.file, 'pw'))], [a.publicKey]), true);
  assert.throws(() => keygen({ dir, passphrase: '' }), /A passphrase is required/);
  assert.equal(keyFiles(dir).length, 2, 'the refused keygen wrote nothing');
});

test('a wrong passphrase or a key file that is not 0600 is refused', () => {
  const dir = path.join(tmp(), 'keys');
  const { file } = keygen({ dir, passphrase: 'pw' });
  assert.throws(() => loadKey(file, 'nope'), /did not open/);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadKey(file, 'pw'), /must be mode 0600/);
});

test('sign computes n from the commit count, signs with every key, and verifies under each', async () => {
  const dir = path.join(tmp(), 'keys');
  const a = keygen({ dir, passphrase: 'pw' }), b = keygen({ dir, passphrase: 'pw' });
  const { cwd, second } = repo();
  git(cwd, 'checkout', '-q', second); // a clean tree at a pushed commit
  const r = await sign({ sha: second, dir, passphrase: 'pw', cwd, run });
  assert.deepEqual([r.sha, r.n, r.sigs.length], [second, 2, 2]);
  assert.equal(verifyRelease(2, second, [r.sigs[0]], [a.publicKey]), true);
  assert.equal(verifyRelease(2, second, [r.sigs[1]], [b.publicKey]), true);
  assert.equal(verifyRelease(2, second, [r.sigs[0]], [b.publicKey]), false, 'each signature belongs to one key');
});

test('sign refuses a dirty tree, a sha not on origin/main, and a missing key', async () => {
  const dir = path.join(tmp(), 'keys');
  const { cwd, second, unpushed } = repo();
  await assert.rejects(sign({ sha: second, dir, passphrase: 'pw', cwd, run }), /No signing key/);
  keygen({ dir, passphrase: 'pw' });
  await assert.rejects(sign({ sha: unpushed, dir, passphrase: 'pw', cwd, run }), /is not on origin\/main/);
  fs.writeFileSync(path.join(cwd, 'f'), 'dirty');
  await assert.rejects(sign({ sha: second, dir, passphrase: 'pw', cwd, run }), /working tree has changes/);
});

test('the printed lines are the three settings and the ssh line', () => {
  const sha = 'd'.repeat(40);
  assert.deepEqual(printed({ sha, n: 7, sigs: ['s1', 's2'], host: 'root@hub.example' }), [
    `HUB_RELEASE=${sha}`, 'HUB_RELEASE_N=7', 'HUB_RELEASE_SIG=s1,s2',
    `ssh root@hub.example /srv/agent-hub/update.sh ${sha} 7 s1,s2`,
  ]);
  assert.equal(printed({ sha, n: 7, sigs: ['s1'], host: null })[3], `ssh <host> /srv/agent-hub/update.sh ${sha} 7 s1`);
});

test('the command line: keygen with the passphrase from the environment, then sign of HEAD, exit 0 and the lines on stdout', async () => {
  const home = tmp();
  const { cwd, second } = repo();
  git(cwd, 'checkout', '-q', second);
  const env = { ...process.env, HOME: home, ACP_SIGNING_KEY: path.join(home, 'keys'), ACP_SIGNING_PASSPHRASE: 'pw', ACP_RELEASE_HOST: 'root@hub.example' };
  delete env.ACP_HUB;
  const tool = path.resolve('tools/release.mjs');
  const gen = await run('node', [tool, 'keygen'], { env, cwd });
  assert.equal(gen.err, null, gen.stderr);
  assert.match(gen.stdout, /^Public key: [A-Za-z0-9+/]{43}=$/m);
  assert.match(gen.stdout, /Back the file up/);
  const s = await run('node', [tool, 'sign'], { env, cwd });
  assert.equal(s.err, null, s.stderr);
  const lines = s.stdout.trim().split('\n');
  assert.equal(lines[0], `HUB_RELEASE=${second}`);
  assert.equal(lines[1], 'HUB_RELEASE_N=2');
  assert.match(lines[2], /^HUB_RELEASE_SIG=[A-Za-z0-9_-]{86}$/);
  assert.equal(lines[3], `ssh root@hub.example /srv/agent-hub/update.sh ${second} 2 ${lines[2].slice('HUB_RELEASE_SIG='.length)}`);
  assert.doesNotMatch(s.stdout + gen.stdout, /PRIVATE KEY|pw/, 'nothing secret is printed');
  const noTty = await run('node', [tool, 'sign'], { env: { ...env, ACP_SIGNING_PASSPHRASE: '' }, cwd });
  assert.equal(noTty.err?.code, 1);
  assert.match(noTty.stderr, /No terminal to ask the passphrase on/);
});
```

(The first test awaits a dynamic import; mark it `async`.)

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/release-tool.test.mjs`
Expected: FAIL, `Cannot find module '…/tools/release.mjs'`.

- [ ] **Step 3: Write `tools/release.mjs`**

The Interfaces above. `main` runs only when the file is the entry module (same detection as Task 1). `--deploy user@host[:dir]` splits on the first `:`; the dir defaults to `/srv/agent-hub`. The `git` calls go through `run` with `{ cwd }`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/release-tool.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add tools/release.mjs test/release-tool.test.mjs
git commit -m "feat(release): the owner's tool: an encrypted key, a signature per key over \"<n> <sha>\", the ssh line"
```

---

### Task 3: The hub serves only a signed release

**Files:**
- Modify: `hub/config.mjs:29-31` (the `release` field)
- Modify: `hub/server.mjs:177-179` (the route)
- Modify: `hub/Dockerfile:5` (copy `release-keys.mjs`)
- Modify: `hub/README.md:40` (settings rows)
- Test: `test/hub-db.test.mjs:17-20`, `test/hub-api.test.mjs:48,107-113`

**Interfaces:**
- Consumes: Task 1's `verifyRelease`, `validN`, `SHA_RE`, `RELEASE_KEYS`.
- Produces: `loadConfig(env = process.env, { keys = RELEASE_KEYS } = {})`; `config.release` is `{ sha, n, sigs } | null`; `config.releaseError` is the 503 sentence (`This hub does not name a release yet.` when `HUB_RELEASE` is unset or not 40 hex; `This hub's release is not signed by a known key.` when it is set but `n`/sigs do not verify). `HUB_RELEASE_N` is parsed with `/^[1-9][0-9]{0,9}$/` → `Number`; `HUB_RELEASE_SIG` is split on `,`, each entry trimmed, empties dropped. `GET /api/release` → `{ ok: true, sha, n, sigs, url }` with the same cache header; 503 `{ ok: false, error: config.releaseError }`.

- [ ] **Step 1: Change the hub-db test**

Replace lines 17-20 of `test/hub-db.test.mjs` with a release block that makes a key pair (`generateKeyPairSync('ed25519')`, `rawPublicKey`, `signRelease` from `../release-keys.mjs`) and asserts:

```js
const good = { HUB_RELEASE: SHA, HUB_RELEASE_N: '12', HUB_RELEASE_SIG: sig };
assert.equal(c.release, null); assert.equal(c.releaseError, 'This hub does not name a release yet.');
assert.deepEqual(loadConfig(good, { keys: [pub] }).release, { sha: SHA, n: 12, sigs: [sig] });
assert.deepEqual(loadConfig({ ...good, HUB_RELEASE_SIG: ` bad , ${sig}, ` }, { keys: [pub] }).release, { sha: SHA, n: 12, sigs: ['bad', sig] }, 'spaces and a trailing comma are tolerated');
for (const env of [{ ...good, HUB_RELEASE_SIG: 'bad' }, { ...good, HUB_RELEASE_N: '13' }, { ...good, HUB_RELEASE_N: '' }, { ...good, HUB_RELEASE_N: '0' }, { HUB_RELEASE: SHA }]) {
  const d = loadConfig(env, { keys: [pub] });
  assert.equal(d.release, null); assert.equal(d.releaseError, "This hub's release is not signed by a known key.");
}
assert.equal(loadConfig(good, { keys: [] }).release, null, 'no keys, no release');
assert.equal(loadConfig(good).release, null, 'the real RELEASE_KEYS does not hold the test key');
for (const bad of ['abc1234', 'A'.repeat(40)]) assert.equal(loadConfig({ ...good, HUB_RELEASE: bad }, { keys: [pub] }).releaseError, 'This hub does not name a release yet.', bad);
```

- [ ] **Step 2: Change the hub-api test**

At line 48 make the signed hub `loadConfig({ …, HUB_RELEASE: SHA, HUB_RELEASE_N: '12', HUB_RELEASE_SIG: SIG }, { keys: [PUB] })` with `PUB`/`SIG` made at module top the same way; add a third hub `unsigned` on its own port with `HUB_RELEASE: SHA` and no signature. Replace the test at lines 107-113:

```js
test('the hub names the release it runs with its number and signatures; one not told answers 503, one badly signed another 503', async () => {
  const r = await call('GET', '/api/release');
  assert.deepEqual([r.status, r.json], [200, { ok: true, sha: SHA, n: 12, sigs: [SIG], url: `https://codeload.github.com/IcyDingo/agent-control-panel/tar.gz/${SHA}` }]);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=30');
  const none = await call('GET', '/api/release', { on: offPort });
  assert.deepEqual([none.status, none.json], [503, { ok: false, error: 'This hub does not name a release yet.' }]);
  const bad = await call('GET', '/api/release', { on: unsignedPort });
  assert.deepEqual([bad.status, bad.json], [503, { ok: false, error: "This hub's release is not signed by a known key." }]);
});
```

- [ ] **Step 3: Run both to see them fail**

Run: `node --test test/hub-db.test.mjs test/hub-api.test.mjs`
Expected: FAIL on `release` / `releaseError`.

- [ ] **Step 4: Implement**

`hub/config.mjs`: import from `../release-keys.mjs`; the second parameter; the two fields with a comment that says the hub refuses to serve what no key signed so a misdeploy is caught on the server. `hub/server.mjs:177-179`: the new body and the sentence from `config.releaseError`. `hub/Dockerfile`: `COPY release-keys.mjs ./release-keys.mjs` after `world.mjs`. `hub/README.md` settings: the `HUB_RELEASE` row says "with `HUB_RELEASE_N` and `HUB_RELEASE_SIG`"; add rows `HUB_RELEASE_N` (the release number, the commit count on `main`; only goes up) and `HUB_RELEASE_SIG` (comma-separated signatures; the release is served only when one verifies against `release-keys.mjs`, else `/api/release` answers 503).

- [ ] **Step 5: Run the whole suite**

Run: `npm test -s 2>&1 | tail -5`
Expected: all pass (`test/install-sh.test.mjs` still parses `sha` and `url` from the longer JSON).

- [ ] **Step 6: Commit**

```bash
git add hub/config.mjs hub/server.mjs hub/Dockerfile hub/README.md test/hub-db.test.mjs test/hub-api.test.mjs
git commit -m "feat(hub): /api/release carries the release number and signatures, and is 503 unless a known key signed it"
```

---

### Task 4: `update.sh` verifies first, refuses a lower number, and refuses a plain deploy once signed

**Files:**
- Modify: `hub/deploy/update.sh`
- Test: `test/update-sh.test.mjs`

**Interfaces:**
- Consumes: Task 1's CLI `node release-keys.mjs verify <sha> <n> <sigs>` and `ACP_RELEASE_KEYS_FILE`.
- Produces: `update.sh` with no arguments (plain mode) or `update.sh <sha> <n> <sigs>` (signed mode). `release.env` lines: `HUB_RELEASE=`, `HUB_RELEASE_N=`, `HUB_RELEASE_SIG=`. Exit 1 on every refusal with the sentence on stderr; `set -e` otherwise as today.

Behaviour, in order:
1. Argument count 0 or 3, else `usage: update.sh [<sha> <n> <sigs>]` and exit 2.
2. Plain mode: if `release.env` exists and has a `HUB_RELEASE_SIG=` line → the deploy sentence, exit 1. Else today's body (pull, write `HUB_RELEASE` only) with `git -C src checkout -q main` before the pull (a signed deploy leaves `src` detached).
3. Signed mode: `sha` must match `^[0-9a-f]{40}$`, `n` must match `^[1-9][0-9]{0,9}$`, `sigs` non-empty, else `update.sh: <sha|n|sigs> is not valid.` exit 1. If `release.env` has `HUB_RELEASE_N=<m>` and `n <= m` → `Release <7> (number <n>) is not newer than the one deployed (<m>).` exit 1. If `src/release-keys.mjs` exists: `docker run --rm -v "$PWD/src/release-keys.mjs:/k.mjs:ro" node:22-alpine node /k.mjs verify "$sha" "$n" "$sigs"` must exit 0, else `Release <7> is not signed by a known key.` exit 1 (a comment says the check is skipped only on the bootstrap deploy, before the file exists). Then `git -C src fetch -q origin`, `git -C src checkout -q --detach "$sha"`, write the three lines to `release.env.new` and `mv` it over `release.env`, `docker compose build -q`, `docker compose up -d`, `sleep 2`, the `/healthz` curl, then `curl -sf -H 'Host: universe.cashegg.com' http://127.0.0.1:4848/api/release` whose failure prints `The hub refuses this release; check release.env and the hub's log.` and exits 1.

- [ ] **Step 1: Write the failing test**

```js
// test/update-sh.test.mjs
// update.sh in a temp /srv/agent-hub: `src` is a clone of a temp origin, `docker` and `curl` on PATH are fakes that
// record their arguments, and `docker run … verify` answers from DOCKER_VERIFY (0 or 1). Hosts and ports are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-sh-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const SIG = 'x'.repeat(86);

function deploy({ keysFile = true } = {}) {
  const origin = tmp(), root = tmp(), bin = path.join(root, 'bin');
  git(origin, 'init', '-q', '-b', 'main'); git(origin, 'config', 'user.email', 't@example.com'); git(origin, 'config', 'user.name', 'T');
  const commit = (m) => { fs.writeFileSync(path.join(origin, 'f'), m); git(origin, 'add', 'f'); git(origin, 'commit', '-q', '-m', m); return git(origin, 'rev-parse', 'HEAD'); };
  const first = commit('one');
  git(root, 'clone', '-q', origin, 'src');
  const second = commit('two');
  if (keysFile) fs.writeFileSync(path.join(root, 'src', 'release-keys.mjs'), '// present\n');
  fs.copyFileSync('hub/deploy/update.sh', path.join(root, 'update.sh')); fs.chmodSync(path.join(root, 'update.sh'), 0o755);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' "docker $*" >> "$FAKE_LOG"\ncase "$1" in run) exit "${DOCKER_VERIFY:-0}";; esac\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' "curl $*" >> "$FAKE_LOG"\nexit "${CURL_EXIT:-0}"\n', { mode: 0o755 });
  const log = path.join(root, 'calls.log');
  const run = (args, env = {}) => spawnSync(path.join(root, 'update.sh'), args, { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...env } });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const env = () => (fs.existsSync(path.join(root, 'release.env')) ? fs.readFileSync(path.join(root, 'release.env'), 'utf8') : null);
  const head = () => git(path.join(root, 'src'), 'rev-parse', 'HEAD');
  return { root, first, second, run, calls, env, head };
}

test('plain mode still pulls main and writes HUB_RELEASE alone, until a signed release exists', () => {
  const d = deploy();
  const r = d.run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(d.env(), `HUB_RELEASE=${d.second}\n`);
  assert.equal(d.head(), d.second);
  assert.ok(d.calls().some((c) => c.startsWith('docker compose build')) && d.calls().some((c) => c.startsWith('curl')));
  fs.writeFileSync(path.join(d.root, 'release.env'), `HUB_RELEASE=${d.second}\nHUB_RELEASE_N=2\nHUB_RELEASE_SIG=${SIG}\n`);
  const refused = d.run([]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /This hub serves signed releases: run  node tools\/release\.mjs sign  on your Mac and use the line it prints\./);
});

test('signed mode verifies before anything else, checks out the sha and writes the three lines', () => {
  const d = deploy();
  const r = d.run([d.second, '2', SIG]);
  assert.equal(r.status, 0, r.stderr);
  const c = d.calls();
  assert.match(c[0], new RegExp(`^docker run --rm -v .*release-keys\\.mjs:/k\\.mjs:ro node:22-alpine node /k\\.mjs verify ${d.second} 2 ${SIG}$`));
  assert.equal(d.head(), d.second);
  assert.equal(d.env(), `HUB_RELEASE=${d.second}\nHUB_RELEASE_N=2\nHUB_RELEASE_SIG=${SIG}\n`);
  assert.ok(c.some((x) => x.includes('/api/release')), 'the release route is checked after the restart');
});

test('a bad signature, a bad argument, or a number that is not newer is refused before any fetch or write', () => {
  const d = deploy();
  const bad = d.run([d.second, '2', SIG], { DOCKER_VERIFY: '1' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, new RegExp(`Release ${d.second.slice(0, 7)} is not signed by a known key\\.`));
  assert.equal(d.head(), d.first, 'nothing checked out');
  assert.equal(d.env(), null, 'nothing written');
  assert.equal(d.calls().filter((c) => c.startsWith('docker compose')).length, 0);
  for (const args of [['abc', '2', SIG], [d.second, 'x', SIG], [d.second, '0', SIG], [d.second, '2', '']]) {
    const r = d.run(args);
    assert.equal(r.status, 1, args.join(' ')); assert.match(r.stderr, /is not valid\./);
  }
  assert.equal(d.run([d.second]).status, 2, 'one argument is a usage error');
  fs.writeFileSync(path.join(d.root, 'release.env'), `HUB_RELEASE=${d.first}\nHUB_RELEASE_N=2\nHUB_RELEASE_SIG=${SIG}\n`);
  const older = d.run([d.second, '2', SIG]);
  assert.equal(older.status, 1);
  assert.match(older.stderr, /\(number 2\) is not newer than the one deployed \(2\)\./);
  assert.equal(d.head(), d.first);
});

test('the bootstrap deploy, before release-keys.mjs exists, skips the verify step and still checks the hub afterwards', () => {
  const d = deploy({ keysFile: false });
  const r = d.run([d.second, '2', SIG], { CURL_EXIT: '22' });
  assert.equal(r.status, 1);
  assert.equal(d.calls().filter((c) => c.startsWith('docker run')).length, 0, 'no verify without the file');
  assert.match(r.stderr, /The hub refuses this release|healthz/);
});

test('the script parses', () => { assert.equal(spawnSync('sh', ['-n', 'hub/deploy/update.sh']).status, 0); });
```

(The bootstrap test's last assertion accepts either failing curl, since the fake fails both; the point is that the script stops with exit 1 after the restart when the hub does not answer.)

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/update-sh.test.mjs`
Expected: FAIL (plain mode passes; signed mode and refusals fail).

- [ ] **Step 3: Rewrite `hub/deploy/update.sh`**

POSIX sh, `set -e`, the behaviour list above, one `refuse() { printf '%s\n' "$1" >&2; exit 1; }` helper. The header comment says: plain mode until the first signed release; then every deploy is the line `tools/release.mjs sign` prints; the hub never goes back to a lower number.

- [ ] **Step 4: Run the tests**

Run: `node --test test/update-sh.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add hub/deploy/update.sh test/update-sh.test.mjs
git commit -m "feat(deploy): update.sh verifies a release before fetching, refuses a lower number and a plain deploy once signed"
```

---

### Task 5: The worker refuses an unsigned or older release, and says so

**Files:**
- Modify: `update.mjs:85-103` (the checks), `update.mjs` exports
- Modify: `server.mjs:1556-1559` (snapshot), `server.mjs:1752-1762` (record the check)
- Modify: `cli.mjs:79-84` (status)
- Test: `test/update.test.mjs`

**Interfaces:**
- Consumes: Task 1's `verifyRelease`, `RELEASE_KEYS`.
- Produces in `update.mjs`:
  - `checkForUpdate({ …, keys = RELEASE_KEYS })` (the keys injectable).
  - `export function releaseOf(dir) → { sha, n } | null` reads `<dir>/release` (`<sha> <n>\n`); anything that is not a 40-hex sha and a positive integer is `null`.
  - `export function writeRelease(dir, sha, n)` writes `release.new` and renames it over `release`.
  - `export function recordCheck(dir, result, now = Date.now)` writes `<dir>/last-check` as JSON `{ at: <iso>, outcome, sha?, error? }` (`release.new`-style rename); `export function lastCheck(dir) → object | null`.
  - New order inside `checkForUpdate`: fetch → `SHA_RE` → `verifyRelease(n, sha, sigs, keys)` else `Release <7> is not signed by a known key.` → `sha === worker.sha`: `writeRelease(dir, sha, n)` (only when `releaseOf(dir)` is null or has a lower `n`), prune, `current` → `held` → floor: `releaseOf(dir)?.n > n` → `Release <7> is older than the one running.` → `notOnMain` → download as today → after the `switch` rename, `writeRelease(dir, sha, n)`.
- `server.mjs`: the check's `.then` calls `recordCheck(WORKER.dir, r)` (guarded with try/catch like `markStarted`); `snapshot()` gains `lastCheck: WORKER ? lastCheck(WORKER.dir) : null`.
- `cli.mjs` `status`: after `Worker <7>`, when `lastCheck(w.dir)` exists: `Last update check <at>: <error>` for an error outcome, `Last update check <at>: up to date` for `current`, `: updates are off` for `off`, `: a release was held back` for `held`.

- [ ] **Step 1: Change the test fixtures and add the tests**

In `test/update.test.mjs`: make a key pair at the top (`generateKeyPairSync`, `rawPublicKey`, `signRelease` from `../release-keys.mjs`), `PUB`, `N = 5`, `SIG = signRelease(N, B, privateKey)`; `names(sha, extra = {})` → `json({ ok: true, sha, n: N, sigs: [SIG], url: 'http://hub.test/archive.tgz', ...extra })` (so the B fixtures verify; `names(A)` will not verify its signature, so the "same sha" test signs A too: `signRelease(N, A, privateKey)` passed through `extra`); `check(w, fetch)` passes `keys: [PUB]`. Then:

```js
test('a release the keys did not sign is an error with no compare and no download', async () => {
  const w = worker();
  for (const bad of [{ sigs: [] }, { sigs: ['x'.repeat(86)] }, { sigs: undefined }, { n: '5' }, { n: 5.5 }, { n: 0 }, { sigs: SIG }]) {
    const fetch = hub(names(B, bad), archive(`agent-control-panel-${B}`));
    const r = await check(w, fetch);
    assert.deepEqual([r.outcome, r.error], ['error', `Release ${B.slice(0, 7)} is not signed by a known key.`], JSON.stringify(bad));
    assert.equal(fetch.calls.length, 1, 'only the hub was asked');
    assert.equal(fs.existsSync(path.join(w.dir, 'switch')), false);
  }
  const other = generateKeyPairSync('ed25519');
  const fetch = hub(names(B, { sigs: [signRelease(N, B, other.privateKey)] }), archive(`agent-control-panel-${B}`));
  assert.equal((await check(w, fetch)).error, `Release ${B.slice(0, 7)} is not signed by a known key.`, 'an unknown key');
  assert.equal((await checkForUpdate({ worker: w, hubUrl: 'http://hub.test', fetch: hub(names(B)), run, keys: [], exit: () => {}, log: () => {} })).outcome, 'error', 'no keys, nothing installs');
});

test('a release numbered below the one on record is an error; the record is written at a switch and rewritten after corruption', async () => {
  const w = worker();
  writeRelease(w.dir, A, 9);
  const fetch = hub(names(B), archive(`agent-control-panel-${B}`));
  const r = await check(w, fetch);
  assert.deepEqual([r.outcome, r.error], ['error', `Release ${B.slice(0, 7)} is older than the one running.`]);
  assert.equal(fetch.calls.length, 1);
  for (const junk of ['garbage\n', `${A}\n`, `${A} x\n`, '']) {
    fs.writeFileSync(path.join(w.dir, 'release'), junk);
    assert.equal(releaseOf(w.dir), null, JSON.stringify(junk));
  }
  const ok = await check(w, hub(names(B), archive(`agent-control-panel-${B}`)));
  assert.equal(ok.outcome, 'switched', 'a corrupt record is no floor');
  assert.deepEqual(releaseOf(w.dir), { sha: B, n: N });
});

test('the same sha records its number the first time, so a fresh install gets a floor at its first check', async () => {
  const w = worker();
  const r = await check(w, hub(names(A, { sigs: [signRelease(N, A, privateKey)] })));
  assert.equal(r.outcome, 'current');
  assert.deepEqual(releaseOf(w.dir), { sha: A, n: N });
});

test('recordCheck and lastCheck keep the last outcome and its sentence', () => {
  const w = worker();
  assert.equal(lastCheck(w.dir), null);
  recordCheck(w.dir, { outcome: 'error', error: 'Release 2222222 is not signed by a known key.' }, () => Date.parse('2026-10-22T10:00:00Z'));
  assert.deepEqual(lastCheck(w.dir), { at: '2026-10-22T10:00:00.000Z', outcome: 'error', error: 'Release 2222222 is not signed by a known key.' });
  recordCheck(w.dir, { outcome: 'current' });
  assert.equal(lastCheck(w.dir).outcome, 'current');
  fs.writeFileSync(path.join(w.dir, 'last-check'), '{');
  assert.equal(lastCheck(w.dir), null);
});
```

Existing tests that name B keep passing once `names` carries `n` and `sigs`; the "same sha" test at line 72 needs the signed-A fixture above.

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/update.test.mjs`
Expected: FAIL (`writeRelease`, `releaseOf`, `recordCheck`, `lastCheck` not exported; new sentences missing).

- [ ] **Step 3: Implement**

`update.mjs`: the Interfaces above. `prune` removes only sha-named entries and `.tmp`/`.tgz` files, so `release`, `release.new` and `last-check` survive it unchanged; no change to `prune`. `server.mjs` and `cli.mjs` as described. The comment above the `release` write says why the floor exists: a signature over an old release is valid forever, the number is what stops a thief with a key from pointing a worker back.

- [ ] **Step 4: Run the whole suite**

Run: `npm test -s 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add update.mjs server.mjs cli.mjs test/update.test.mjs
git commit -m "feat(worker): a release is installed only when a known key signed it and its number is not below the one on record; status shows the last check"
```

---

### Task 6: The owner's instructions: releasing, rotating, the first signed deploy, a deploy-only key

**Files:**
- Modify: `hub/README.md` (new `## Releases` section before `## Behind Caddy`)
- Modify: `hub/deploy/README.md:11,24-44` (what `update.sh` does; "Every later release"; the upgrade; the checks)
- Modify: `README.md:18-19` (the updates line), `README.md:552-553` (the Security bullet about the worker)

**Interfaces:** Consumes the commands and sentences of Tasks 2 and 4 verbatim.

- [ ] **Step 1: `hub/README.md` "Releases"**

In this order, short paragraphs and one code block each: what a release is (a commit on `main`, a number, one signature per key; the hub serves it at `/api/release`; a worker installs nothing else and never a lower number). Making the key once: `node tools/release.mjs keygen`, the passphrase, pasting the printed key into `RELEASE_KEYS` in `release-keys.mjs`, committing, backing the file up (where it lives; it is outside the folder an uninstall deletes; a lost key or passphrase means re-installing every worker with the one line, never weakening the check). Releasing: `node tools/release.mjs sign` on a clean checkout of `main`, what it prints, `ACP_RELEASE_HOST`, `--deploy`. Rotating: `keygen` again (now two signatures per release), add the key, release, wait 30 days (a worker checks daily; one asleep longer re-installs), delete the old file and remove it from `RELEASE_KEYS` in a release signed by the new key alone. A stolen key (file and passphrase): remove it from `RELEASE_KEYS` in a release signed by the rest, at once; until a worker has that release the thief can only sign a commit that is on `main` and newer than what the worker runs, so they also need the GitHub account.

- [ ] **Step 2: `hub/deploy/README.md`**

Line 11: `update.sh             deploy the signed release tools/release.mjs sign names (verifies first, never a lower number); plain, it pulls main until the first signed release`. Replace "Every later release" and the upgrade paragraph with: the first signed deploy (`git -C src fetch -q origin main && git -C src show origin/main:hub/deploy/update.sh > update.sh && chmod +x update.sh`, then the line `sign` printed; note that before this, pasting the public key into `release-keys.mjs` must be merged on `main`), every later release (`node tools/release.mjs sign` on the Mac, the ssh line or `--deploy`), and what a refused plain `./update.sh` prints. Add a short "A deploy-only key (optional)" paragraph: a second ssh key made on the Mac for `release.mjs --deploy`, whose line in `/root/.ssh/authorized_keys` starts with `command="/srv/agent-hub/deploy-only.sh",no-port-forwarding,no-pty,no-agent-forwarding,no-X11-forwarding`. Show `deploy-only.sh` in full (six lines): it takes `$SSH_ORIGINAL_COMMAND`, strips a leading `/srv/agent-hub/update.sh `, requires the rest to match `^[0-9a-f]{40} [1-9][0-9]* [A-Za-z0-9_,-]+$` (else `printf 'deploy key: only  update.sh <sha> <n> <sigs>  is allowed.\n' >&2; exit 1`), and runs `exec /srv/agent-hub/update.sh $rest` unquoted so the three fields split. State that this key can deploy and nothing else, and that the admin key stays as it is. The check lines at the end gain `curl -fsSL https://universe.cashegg.com/api/release` → `{"ok":true,"sha":"…","n":…,"sigs":["…"],"url":"…"}`.

- [ ] **Step 3: `README.md`**

Line 18: `Updates are daily, only to a release signed by the project's key on the maintainer's Mac, never to an older one, and a version that cannot start is rolled back; to turn them off:`. The Security bullet at 552-553: `The worker only ever installs a commit the hub names that is on the repository's main, numbered above the one it runs, and signed by a key listed in release-keys.mjs (the private half lives on the maintainer's Mac, encrypted); downloaded from GitHub over https, verified before the download.`

- [ ] **Step 4: Check and commit**

Run: `npm test -s 2>&1 | tail -3` (docs touch no test, but the suite is the gate) and read each changed README passage once in place.

```bash
git add hub/README.md hub/deploy/README.md README.md
git commit -m "docs(release): how a release is made, rotated and first deployed signed; a deploy-only ssh key; the README's promise"
```

---

## Rollout, after merge (the owner, by hand)

1. `node tools/release.mjs keygen` on the Mac; paste the key into `RELEASE_KEYS`; PR; merge.
2. `git pull` on `main`; `node tools/release.mjs sign` → copy the ssh line.
3. On the server, once: fetch and copy the new `update.sh` (deploy README), then run the ssh line. `/api/release` now carries `n` and `sigs`; the one-line install works; the owner's own worker switches within a day.
4. From now on a plain `./update.sh` is refused; every release is `sign`.
