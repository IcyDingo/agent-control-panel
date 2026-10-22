# Social universe, slices 3–4: the hub, sign-in and sync from the Mac, orders from the site

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hub you can run locally (and later host) where each developer's system is shown by handle, and a Mac that signs in once, pushes its public projection, and executes the orders (push, rocket, build) its owner places on the site.

**Architecture:** The hub is one Node process under `hub/` with SQLite (`node:sqlite`) behind `hub/db.mjs`; small modules own accounts, auth, systems, orders and the HTTP surface; the website is plain HTML + JS that fetches JSON and reuses `public/world.js` read-only. The Mac side is three modules beside `server.mjs`: `hub.mjs` (credentials file, requests, device flow, SSE parsing), `hub-sync.mjs` (debounced push of the projection and the owner-only status), `hub-orders.mjs` (listen for orders, run them through the same functions the panel uses, report back). The page only talks to the local server; the local server proxies.

**Tech Stack:** Node 20+ for the panel, Node 22.13+ for the hub (`node:sqlite`), standard library only, `node:test`. No build step, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-social-universe-design.md` (sections "Hub data model", "Auth", "Hub HTTP API", "Panel side: sync and proxies", "Orders", "Panel UI additions"). Slices 1–2 are on the branch already (`daemon.mjs`, `cli.mjs`, `sunOf`, `publicProjection`, `validProjection`, `readOnly`).

## Global Constraints

- Standard library only; no build step; `package.json` keeps `"engines": {"node": ">=20"}` (the hub documents its own 22.13+ floor in `hub/README.md`).
- `node:sqlite` prints an ExperimentalWarning before Node 24; `npm test` becomes `node --no-warnings=ExperimentalWarning --test` (verified to propagate to test children) so test output stays pristine.
- The hub receives only `publicProjection` output and the owner-only status; it re-validates every projection with `validProjection` and stores the re-serialised result. The owner-only status is never in a public read.
- No CORS headers anywhere; the page talks to the local server only; the local server talks to the hub with `Authorization: Bearer hub_…`.
- Hub web writes need the session cookie **and** `Origin === HUB_PUBLIC_URL`'s origin; JSON bodies only; `Host` must equal the public URL's host (421 otherwise); hub responses `cache-control: no-store` except static files and public GETs (`max-age=30`).
- Tokens and session ids are stored hashed (sha256); `hub.json` on the Mac is mode 0600, written tmp+rename; the token never appears in a panel snapshot or a log line.
- Hub-side errors are `{ ok: false, error: '<a sentence>' }` with 400/401/403/404/409/413/422; the panel's own rule (`{ ok, error }`) stays.
- Handle rule: `^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$`, reserved `me, api, device, login, logout, chat, friends, universe, home, admin, hub`; bio ≤ 160, name ≤ 40, link ≤ 200 and `https?://`.
- Coordinates: Vogel spiral `r = 60·√ordinal`, angle `ordinal·π(3−√5)`, ±12 hashed jitter, integers; `(0,0)` never issued; permanent.
- Nothing hub-related sits on the local request path or slows a scan: every hub call has a timeout (8 s), never throws into the caller, and failures surface only in `snapshot().hub.sync`.
- One pending order per account; orders expire after 24 h; the Mac runs an order through the very same `buyInWorld` / `buildInWorld` the panel uses.
- Public repository: no personal paths, names or handles in code, fixtures or docs; fixtures use `/Users/someone`, `alice`, `bob`.
- House style: one concern per module, plain-sentence comments saying what and why, tests with `node:test` + `node:assert/strict`, temp dirs via `fs.mkdtempSync(path.join(os.tmpdir(), '<name>-'))`.

## Review Focus

1. A projection the hub refuses (422) forever, e.g. after a `summary()` change drifts past a limit: the Mac must say so in the side panel, not retry silently (Task 9 test: a 422 sets `lastError` with the hub's sentence and stops retrying until the projection changes).
2. A device code approved on the site but polled after it expired, or polled twice: the token is collected exactly once and the second poll gets 410 (Task 4 test).
3. A hostile `Host` or `Origin` on a cookie write (CSRF from another site): refused with 421/403 (Task 7 test).
4. An order placed while the Mac is asleep: it must still be executed when the Mac wakes, not lost (Task 10 test: pending orders are fetched on connect before the stream is consumed).
5. Two Macs on one account: the second push must not be rejected forever; last writer wins and the first Mac learns it (Task 9 test: a 409 `stale` is logged as "Another Mac is syncing this account" and the next push still goes).

---

## Part A: the hub

### Task 1: `hub/config.mjs`, `hub/db.mjs`, the quiet test runner

**Files:**
- Create: `hub/config.mjs`, `hub/db.mjs`
- Modify: `package.json:12` (test script)
- Test: `test/hub-db.test.mjs`

**Interfaces:**
- Produces:
  - `loadConfig(env = process.env): { port: number, dataDir: string, publicUrl: string, origin: string, host: string, github: { clientId, clientSecret } | null, devLogin: boolean, trustProxy: boolean }` — `HUB_PORT` (4848), `HUB_DATA` (`./data`), `HUB_PUBLIC_URL` (`http://127.0.0.1:<port>`), `HUB_GITHUB_CLIENT_ID`/`_SECRET` (both or null), `HUB_DEV_LOGIN=1`, `HUB_TRUST_PROXY=1`. Throws `Error('HUB_DEV_LOGIN is refused on an https public URL')` when both.
  - `openDb(dataDir): DatabaseSync` — creates the folder, opens `<dataDir>/hub.sqlite` (`:memory:` allowed), `PRAGMA journal_mode=WAL; busy_timeout=5000; foreign_keys=ON`, runs migrations by `schema_version`.
  - `SCHEMA_VERSION = 1`, `MIGRATIONS: string[]` (index 0 is v1, exactly the spec's tables: `accounts, identities, sessions, client_tokens, device_codes, oauth_states, systems, schema_version`, plus `statuses(account_id PK, status TEXT, received_at)` and `orders(id PK, account_id, kind, body TEXT, status 'pending'|'done'|'failed'|'expired', created_at, done_at, result TEXT)` with `CREATE INDEX orders_pending ON orders(account_id, status)`).

- [ ] **Step 1: Write the failing tests**

```js
// test/hub-db.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadConfig } from '../hub/config.mjs';
import { openDb, SCHEMA_VERSION } from '../hub/db.mjs';

test('config reads the environment with the documented defaults', () => {
  const c = loadConfig({});
  assert.deepEqual([c.port, c.dataDir, c.publicUrl, c.origin, c.host, c.github, c.devLogin, c.trustProxy], [4848, './data', 'http://127.0.0.1:4848', 'http://127.0.0.1:4848', '127.0.0.1:4848', null, false, false]);
  const d = loadConfig({ HUB_PORT: '9000', HUB_PUBLIC_URL: 'https://hub.example.com/', HUB_GITHUB_CLIENT_ID: 'id', HUB_GITHUB_CLIENT_SECRET: 's', HUB_TRUST_PROXY: '1' });
  assert.deepEqual([d.port, d.publicUrl, d.origin, d.host, d.github, d.trustProxy], [9000, 'https://hub.example.com', 'https://hub.example.com', 'hub.example.com', { clientId: 'id', clientSecret: 's' }, true]);
  assert.throws(() => loadConfig({ HUB_PUBLIC_URL: 'https://hub.example.com', HUB_DEV_LOGIN: '1' }), /refused on an https/);
});

test('the database is created with every table, in WAL mode, and opening it again is a no-op', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')), 'data');
  const db = openDb(dir);
  const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((r) => r.name);
  for (const t of ['accounts', 'identities', 'sessions', 'client_tokens', 'device_codes', 'oauth_states', 'systems', 'statuses', 'orders', 'schema_version']) assert.ok(tables.includes(t), t);
  assert.equal(db.prepare('select v from schema_version').get().v, SCHEMA_VERSION);
  assert.equal(db.prepare('pragma journal_mode').get().journal_mode, 'wal');
  db.close();
  assert.equal(openDb(dir).prepare('select v from schema_version').get().v, SCHEMA_VERSION);
  assert.ok(fs.existsSync(path.join(dir, 'hub.sqlite')));
});
```

- [ ] **Step 2: Run to verify failure** — `node --no-warnings=ExperimentalWarning --test test/hub-db.test.mjs` → FAIL, cannot find module.
- [ ] **Step 3: Implement** both modules; change `package.json`'s test script to `node --no-warnings=ExperimentalWarning --test`. `db.mjs` header comment: why SQLite (one file, indexes for the map and chat, one process) and that every other module takes the `db` it returns.
- [ ] **Step 4: Run** `npm test` → all green, and the output contains no `ExperimentalWarning` (`npm test 2>&1 | grep -c Experimental` prints 0).
- [ ] **Step 5: Commit** `feat(hub): config, the SQLite database and its first schema`

### Task 2: `hub/coords.mjs` and `hub/validate.mjs`

**Files:** Create `hub/coords.mjs`, `hub/validate.mjs`; Test `test/hub-coords.test.mjs`, `test/hub-validate.test.mjs`.

**Interfaces:**
- Produces: `SPACING = 60, JITTER = 12`; `placeOf(ordinal: number): { x: number, y: number }` (integers; `hash` is sha1 of `String(ordinal)` → two numbers in [0,1) from the first and second 8 hex chars, as `world.mjs`'s `hash` does); `bbox({ x0, y0, x1, y1 }, max = 4000): { x0, y0, x1, y1 } | null` (normalised, null when a side exceeds `max` or a value is not finite).
- `RESERVED: Set<string>`; `handle(raw): string | null` (lowercased, the rule, not reserved); `text(raw, max): string | null` (string, NFC, control characters stripped, whitespace collapsed to single spaces except `\n` kept when `max >= 1000`, trimmed, non-empty, ≤ max); `optionalText(raw, max)` (same but `''` → `''`); `link(raw): string | '' | null` (`''` allowed, else `https?://`, ≤ 200, no whitespace); `coordsText('412, -88'): { x, y } | null` (two integers, `|v| ≤ 1e6`, separators `,` and spaces, a leading `@`-less string only).

- [ ] **Step 1: Tests**

```js
// test/hub-coords.test.mjs
test('placement is deterministic, never (0,0), and every pair in the first 20,000 is more than 60 apart', () => {
  assert.deepEqual(placeOf(1), placeOf(1));
  const seen = new Map();
  for (let i = 1; i <= 20_000; i++) { const p = placeOf(i); assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y)); assert.ok(p.x !== 0 || p.y !== 0); seen.set(`${p.x},${p.y}`, i); }
  assert.equal(seen.size, 20_000, 'all distinct');
  // the ring of ordinals 1..400 against each other, exhaustively; the rest by the spiral's spacing
  const pts = Array.from({ length: 400 }, (_, i) => placeOf(i + 1));
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) > 60, `${i + 1} vs ${j + 1}`);
  assert.ok(Math.hypot(placeOf(50).x, placeOf(50).y) > 380 && Math.hypot(placeOf(50).x, placeOf(50).y) < 470, 'ordinal 50 lands near r 424');
});
test('a window is normalised and capped', () => {
  assert.deepEqual(bbox({ x0: 10, y0: 10, x1: -10, y1: -10 }), { x0: -10, y0: -10, x1: 10, y1: 10 });
  assert.equal(bbox({ x0: 0, y0: 0, x1: 4001, y1: 0 }), null);
  assert.equal(bbox({ x0: NaN, y0: 0, x1: 1, y1: 1 }), null);
});
```

```js
// test/hub-validate.test.mjs
test('handles follow GitHub rules, lowercased, and reserved words are refused', () => {
  assert.equal(handle('Alice-1'), 'alice-1');
  assert.equal(handle('a'.repeat(39)), 'a'.repeat(39));
  for (const bad of ['a'.repeat(40), '-a', 'a-', 'a_b', '', 'me', 'API', 'Universe', 42]) assert.equal(handle(bad), null, String(bad));
});
test('text is tidied and bounded; a link is https and short; coordinates parse', () => {
  assert.equal(text('  hello   there\u0007 ', 40), 'hello there');
  assert.equal(text('x'.repeat(41), 40), null);
  assert.equal(text('', 40), null);
  assert.equal(optionalText('', 160), '');
  assert.equal(link(''), '');
  assert.equal(link('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  for (const bad of ['ftp://x', 'javascript:alert(1)', 'https://x y', 'https://' + 'x'.repeat(200)]) assert.equal(link(bad), null, bad);
  assert.deepEqual(coordsText('412, -88'), { x: 412, y: -88 });
  assert.deepEqual(coordsText(' -3 7 '), { x: -3, y: 7 });
  for (const bad of ['412', '1e7, 0', '1.5, 2', '@alice', 'x, y']) assert.equal(coordsText(bad), null, bad);
});
```

- [ ] **Step 2: Run → FAIL.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(hub): a place for every account in a spiral universe, and what a handle, a text and a link may be`

### Task 3: `hub/accounts.mjs`

**Files:** Create `hub/accounts.mjs`; Test `test/hub-accounts.test.mjs`.

**Interfaces:**
- Consumes: `openDb`, `placeOf`, `handle`, `text`, `optionalText`, `link`.
- Produces: `createAccounts(db, { now = Date.now, random = crypto.randomUUID })` →
  - `signIn({ provider, subject, login, avatar, email }): { account, created: boolean }` — existing identity → its account; else a transaction: `ordinal = max+1`, `{x, y} = placeOf(ordinal)`, handle = `handle(login)` or, if null or taken, `${handle(login) ?? 'dev'}-${ordinal}`, `avatar` kept only when it starts with `https://avatars.githubusercontent.com/` else null, insert account + identity.
  - `byId(id)`, `byHandle(handle)` (case-insensitive) → `{ id, ordinal, handle, x, y, name, bio, link, avatar, visibility, showFriends, createdAt }` or null.
  - `updateProfile(id, { handle?, name?, bio?, link?, visibility?, showFriends? }): { ok, account } | { ok: false, status: 409 | 422, error }` — validators from Task 2; handle change refused with 409 `'That handle is taken.'` or `'A handle changes at most once a week.'` (`handle_changed_at` within 7 days); visibility ∈ `public|unlisted`.
  - `identitiesOf(id): [{ provider, login }]`; `byCoords(x, y)` → the account at exactly that spot or null.

- [ ] **Step 1: Tests** (`db = openDb(':memory:')`, `accounts = createAccounts(db, { now: () => T })`):

```js
test('the first sign-in creates an account at the next spiral spot; the second returns it', () => {
  const a = accounts.signIn({ provider: 'github', subject: '1', login: 'Alice', avatar: 'https://avatars.githubusercontent.com/u/1' });
  assert.equal(a.created, true);
  assert.deepEqual([a.account.ordinal, a.account.handle, { x: a.account.x, y: a.account.y }], [1, 'alice', placeOf(1)]);
  const again = accounts.signIn({ provider: 'github', subject: '1', login: 'alice-renamed' });
  assert.deepEqual([again.created, again.account.id, again.account.handle], [false, a.account.id, 'alice']);
});
test('a taken or invalid login gets a numbered handle; a foreign avatar is dropped', () => {
  accounts.signIn({ provider: 'github', subject: '1', login: 'alice' });
  const b = accounts.signIn({ provider: 'github', subject: '2', login: 'ALICE', avatar: 'https://evil.example/x.png' });
  assert.deepEqual([b.account.handle, b.account.avatar, b.account.ordinal], ['alice-2', null, 2]);
  assert.equal(accounts.signIn({ provider: 'dev', subject: 'x', login: '-bad-' }).account.handle, 'dev-3');
});
test('profile edits are validated; a handle changes once a week and never to a taken one', () => {
  const { account: a } = accounts.signIn({ provider: 'github', subject: '1', login: 'alice' });
  accounts.signIn({ provider: 'github', subject: '2', login: 'bob' });
  assert.equal(accounts.updateProfile(a.id, { bio: 'x'.repeat(161) }).status, 422);
  assert.equal(accounts.updateProfile(a.id, { link: 'ftp://x' }).status, 422);
  assert.deepEqual(accounts.updateProfile(a.id, { handle: 'bob' }), { ok: false, status: 409, error: 'That handle is taken.' });
  assert.equal(accounts.updateProfile(a.id, { handle: 'alice2', name: 'Alice', bio: 'hi', link: 'https://a.example' }).account.handle, 'alice2');
  assert.equal(accounts.updateProfile(a.id, { handle: 'alice3' }).error, 'A handle changes at most once a week.');
  assert.equal(accounts.byHandle('ALICE2').id, a.id);
  assert.equal(accounts.byHandle('alice'), null);
});
```

- [ ] **Steps 2–4: RED, implement, GREEN.** - [ ] **Step 5: Commit** `feat(hub): accounts and identities; a handle, a spot, a profile`

### Task 4: `hub/auth.mjs` and `hub/github.mjs`

**Files:** Create `hub/auth.mjs`, `hub/github.mjs`; Test `test/hub-auth.test.mjs`.

**Interfaces:**
- Produces (`createAuth(db, { now = Date.now, randomBytes = crypto.randomBytes })`):
  - Sessions: `createSession(accountId, ua = ''): string` (32 random bytes base64url, stored sha256, 30 days), `sessionAccountId(sessionId): string | null` (null when expired), `deleteSession(sessionId)`.
  - Client tokens: `mintToken(accountId, { label, device }): { id, token }` (`token = 'hub_' + 32 bytes base64url`, stored sha256, `scopes 'client'`), `tokenAccountId(token): string | null` (revoked → null; bumps `last_used_at` at most once a minute), `listTokens(accountId): [{ id, label, device, createdAt, lastUsedAt }]`, `revokeToken(accountId, id): boolean`, `revokeByToken(token): boolean`.
  - Device flow: `DEVICE_TTL_MS = 900_000`, `DEVICE_INTERVAL_S = 5`; `startDevice(): { device_code, user_code, expires_in: 900, interval: 5 }` (`user_code` 8 chars from `BCDFGHJKLMNPQRSTVWXZ23456789` as `XXXX-XXXX`, `device_code` 32 bytes base64url stored hashed); `approveDevice(user_code, accountId, label): { ok } | { ok: false, error }` (mints a token labelled `label` with `device = user_code`, parks the plain token, status `approved`); `denyDevice(user_code)`; `pollDevice(device_code): { status: 'pending' | 'slow_down' | 'expired' | 'denied' | 'ok' | 'unknown', token?, accountId? }` — `slow_down` when polled within `interval` s of the last poll (and the interval grows by 5 s each time), `ok` exactly once (`token_plain` nulled, status `used`), `expired` after `expires_in` or when `used`/`expired`.
  - OAuth states: `newState(returnTo): string` (10-minute TTL; `returnTo` kept only when it starts with `/` and not `//`), `takeState(state): { returnTo } | null` (single use).
- `hub/github.mjs`: `authorizeUrl({ clientId, state, redirectUri }): string` (`https://github.com/login/oauth/authorize?client_id&state&redirect_uri`, no scope); `async exchange({ code, clientId, clientSecret, fetch }): { subject, login, avatar } | null` (POST `https://github.com/login/oauth/access_token` with `Accept: application/json`, then GET `https://api.github.com/user` with the bearer token and `User-Agent: agent-panel-hub`; null on any failure; `subject = String(id)`).

- [ ] **Step 1: Tests** (fixed `now`, a deterministic `randomBytes` counter so codes are reproducible):

```js
test('a session is found until it expires, and a deleted one is gone', ...)             // 30 days
test('a client token verifies, lists without its secret, and revokes by id or by itself', ...)
test('the device flow: pending → approved → collected once; expired; denied; slow_down', () => {
  const d = auth.startDevice();
  assert.match(d.user_code, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
  assert.deepEqual([d.expires_in, d.interval], [900, 5]);
  assert.equal(auth.pollDevice(d.device_code).status, 'pending');
  assert.equal(auth.pollDevice(d.device_code).status, 'slow_down', 'polled again at once');
  clock.add(10_000);
  assert.equal(auth.approveDevice(d.user_code, 'acct-1', 'Agent Panel on a Mac').ok, true);
  const got = auth.pollDevice(d.device_code);
  assert.deepEqual([got.status, got.accountId, got.token.startsWith('hub_')], ['ok', 'acct-1', true]);
  assert.equal(auth.tokenAccountId(got.token), 'acct-1');
  clock.add(10_000);
  assert.equal(auth.pollDevice(d.device_code).status, 'expired', 'collected once');
  const e = auth.startDevice(); clock.add(900_001); assert.equal(auth.pollDevice(e.device_code).status, 'expired');
  const f = auth.startDevice(); auth.denyDevice(f.user_code); clock.add(10_000); assert.equal(auth.pollDevice(f.device_code).status, 'denied');
  assert.equal(auth.pollDevice('nonsense').status, 'unknown');
  assert.equal(auth.approveDevice('XXXX-XXXX', 'acct-1', 'x').ok, false);
});
test('an oauth state is single-use, short-lived, and only keeps a local return path', () => {
  assert.deepEqual(auth.takeState(auth.newState('/@alice')), { returnTo: '/@alice' });
  assert.deepEqual(auth.takeState(auth.newState('https://evil.example')), { returnTo: null });
  assert.deepEqual(auth.takeState(auth.newState('//evil.example')), { returnTo: null });
  const s = auth.newState('/x'); assert.ok(auth.takeState(s)); assert.equal(auth.takeState(s), null);
  const t = auth.newState('/x'); clock.add(600_001); assert.equal(auth.takeState(t), null);
});
test('github: the authorize url carries no scope; exchange returns the numeric id as subject or null', async () => {
  const url = new URL(authorizeUrl({ clientId: 'cid', state: 'st', redirectUri: 'https://h/auth/github/callback' }));
  assert.deepEqual([url.origin + url.pathname, url.searchParams.get('client_id'), url.searchParams.get('state'), url.searchParams.has('scope')], ['https://github.com/login/oauth/authorize', 'cid', 'st', false]);
  const calls = [];
  const fetch = async (u, init) => { calls.push([u, init?.headers?.Accept ?? init?.headers?.accept]); return u.includes('access_token') ? { ok: true, json: async () => ({ access_token: 'gho_x' }) } : { ok: true, json: async () => ({ id: 42, login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/42' }) }; };
  assert.deepEqual(await exchange({ code: 'c', clientId: 'cid', clientSecret: 's', fetch }), { subject: '42', login: 'alice', avatar: 'https://avatars.githubusercontent.com/u/42' });
  assert.equal(await exchange({ code: 'c', clientId: 'cid', clientSecret: 's', fetch: async () => ({ ok: false }) }), null);
});
```

Write the first two tests fully in the same style (assert a session id is not stored in clear: `select id_hash` never equals the id).

- [ ] **Steps 2–4.** - [ ] **Step 5: Commit** `feat(hub): sessions, client tokens, the device flow and GitHub sign-in`

### Task 5: `hub/systems.mjs` and `hub/orders.mjs`

**Files:** Create `hub/systems.mjs`, `hub/orders.mjs`; Test `test/hub-systems.test.mjs`.

**Interfaces:**
- Consumes: `validProjection`, `colonyName`, `LEVELS` from `../world.mjs`.
- Produces `createSystems(db, { now })`:
  - `put(accountId, { pv, seq, device, snapshot }): { ok: true, seq, hash, unchanged?: true } | { ok: false, status: 422 | 409, error, seq? }` — `validProjection(snapshot)` null → 422 `'The system could not be read; nothing was stored.'`; `seq` not a finite number → 422; `seq < stored.seq` → 409 `{ error: 'stale', seq: stored.seq }`; equal sha256 of the canonical JSON → `unchanged`; else store with derived `level, stage, days_worked, colonies (planets with a colony), builds`.
  - `get(accountId): { snapshot, level, stage, daysWorked, colonies, builds, receivedAt } | null`.
  - `putStatus(accountId, status): { ok }` (shape-checked: `balance, prices{frontier,rocket,build}, today{credit,commits,added,removed,tokens,multiplier}, home{xp,today}, building, mac{name,online}`; numbers finite; `mac.name` text ≤ 40; anything else → 422), `getStatus(accountId): object | null`.
  - `publicView(account, system): { profile: { handle, name, bio, link, avatar, x, y, joined: 'YYYY-MM-DD', visibility }, stats: { level, stage, daysWorked, colonies, builds, lastActive: 'YYYY-MM-DD' | null }, system: snapshot | null }` (`joined` from `createdAt`, `lastActive` from `receivedAt`; both UTC dates).
- Produces `createOrders(db, { now, random })`:
  - `ORDER_TTL_MS = 86_400_000`; `place(accountId, body): { ok, order } | { ok: false, status: 409 | 422, error }` — kinds and validation per the spec; one pending → 409 `"One thing at a time: the last order hasn't landed yet."`; `order = { id, kind, ...fields, status: 'pending', createdAt }`.
  - `pending(accountId): order[]` (expiring stale ones first), `list(accountId, limit = 20)` newest first, `done(accountId, id, { ok, error, caption }): { ok } | { ok: false, status: 404 }` (status `done` or `failed`, `result` JSON), `expire(now)`.

- [ ] **Step 1: Tests** — using `publicProjection` of a seeded World (copy the `seeded` fixture from `test/world-projection.test.mjs`): put valid → `{ ok, seq, hash }` and `get().level` matches; same payload → `unchanged`; older `seq` → 409 with the stored seq; extra key in the snapshot → 422 and `get()` unchanged; `putStatus` valid / 422 on a string balance; `publicView` has no `balance` anywhere in its JSON and `joined` is a date; orders: place frontier/rocket/build, second pending → 409, bad build text (301 chars) → 422, bad colony name → 422, `done` marks and returns, `pending` after 24 h is empty and the row is `expired`.

- [ ] **Steps 2–4.** - [ ] **Step 5: Commit** `feat(hub): systems and the owner's status, and orders the Mac will execute`

### Task 6: `hub/live.mjs`, the per-account event stream

**Files:** Create `hub/live.mjs`; Test `test/hub-live.test.mjs`.

**Interfaces:**
- Produces `createLive()`: `subscribe(accountId, res): () => void` (writes the SSE headers, `retry: 2000`, a `: ping` every 20 s, returns an unsubscribe that clears the ping; at most 5 streams per account, the oldest is closed), `emit(accountId, event: string, data: object)` (writes `event: <name>\ndata: <json>\n\n` to every subscriber), `count(accountId)`.

- [ ] **Step 1: Test** with a fake `res` (`{ writeHead, write, end, on }` recording writes): subscribe writes headers and `retry`; `emit('order', {id:'o1'})` writes exactly `event: order\ndata: {"id":"o1"}\n\n`; unsubscribe stops further writes; a sixth stream closes the first (`end` called); `count` follows.
- [ ] **Steps 2–4.** - [ ] **Step 5: Commit** `feat(hub): a live event stream per account`

### Task 7: `hub/server.mjs`, the HTTP surface, and the API test

**Files:** Create `hub/server.mjs`; Test `test/hub-api.test.mjs`.

**Interfaces:**
- Consumes: everything above.
- Produces `createHub(config): { server: http.Server, listen(port?: number): Promise<{ port }>, close(): Promise<void>, db, accounts, auth, systems, orders, live }` (the modules exposed so tests can seed accounts and mint tokens directly) and, when run as `node hub/server.mjs`, listens on `config.port` on `0.0.0.0` and logs `hub → <publicUrl>`.
- Routing (all paths from the spec's API table that this slice needs):
  - `GET /healthz` → `{ ok: true, v: 1 }`.
  - Static: `GET /world.js` (the repo's `public/world.js`), `GET /hub.js`, `/hub.css`, `/robots.txt` from `hub/public`, `max-age=300`.
  - Pages (`hub/public/*.html`, `max-age=30`, served by Task 8; until then a 404 is fine): `/` → `index.html`, `/@:handle` → `system.html`, `/me` → `me.html`, `/device` → `device.html`.
  - `GET /api/systems/@:handle` (pub) → `publicView` or 404 `'No system by that name.'`; `GET /api/systems/at?x&y` (pub).
  - `GET /login/github?return_to=` (302 to GitHub, or 404 `'GitHub sign-in is not configured on this hub.'`), `GET /auth/github/callback?code&state` (exchange → `accounts.signIn` → session cookie → 302 `returnTo ?? '/me'`), `POST /logout` (web), `POST /auth/dev { login }` (only `config.devLogin`; `signIn({ provider: 'dev', subject: login, login })` → cookie → `{ ok, account }`).
  - `POST /api/device/code` (pub) → `{ ok, device_code, user_code, verification_uri: '<publicUrl>/device', verification_uri_complete: '<publicUrl>/device?code=<user_code>', expires_in, interval }`; `POST /api/device/token { device_code }` (pub) → `200 { ok, token, account: { id, handle, x, y } }` | `428 { error: 'authorization_pending' }` | `429 { error: 'slow_down' }` | `410 { error: 'expired' }` | `403 { error: 'denied' }` | `404`; `POST /api/device/approve { user_code, label }` (web), `POST /api/device/deny` (web).
  - `GET /api/me` (any) → `{ ok, account, identities, tokens (web only), status: getStatus(), orders: list(…, 5) }`; `PATCH /api/me/profile` (web); `DELETE /api/me/tokens/:id` (web); `DELETE /api/me/tokens/self` (tok).
  - `PUT /api/me/system` (tok, 512 KB) → `systems.put`; `PUT /api/me/status` (tok, 16 KB) → `putStatus`; `GET /api/me/status` (any).
  - `GET /api/me/orders?status=pending` (any), `POST /api/me/orders` (web) → `orders.place` + `live.emit(id, 'order', order)`, `POST /api/me/orders/:id/done` (tok) → `orders.done` + `live.emit(id, 'order_done', { id, ...result })`.
  - `GET /api/me/events` (any; Bearer header or cookie, never a query token) → `live.subscribe`.
- Auth helpers inside: `requester(req): { accountId, via: 'web' | 'tok' } | null`; web writes also need `Origin === config.origin`; a missing/wrong `Host` → 421 before anything else; bodies capped (`MAX_BODY` 16 KB default, 512 KB for the system PUT) → 413; JSON parse failure → 400. Every handler runs inside a try/catch that answers 500 `{ error: 'server error' }` and never throws out (same shape as `server.mjs:1483`). Cookie: `hub_s=<id>; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000` + `; Secure` when `publicUrl` is https.

- [ ] **Step 1: Write the API test** — `createHub(loadConfig({ HUB_DATA: tmp, HUB_DEV_LOGIN: '1', HUB_PUBLIC_URL: 'http://127.0.0.1' }))`, `listen(0)`, and a tiny client `call(method, path, { body, cookie, token, origin, host })` over `fetch` that returns `{ status, json, setCookie }`. The `host` header must be `127.0.0.1` for every call (the server accepts `config.host` and, when `config.port` is 0, any `127.0.0.1[:port]`: make `createHub` accept `config.host` and the actual bound port). Tests:
  - `healthz`; wrong `Host` → 421.
  - dev sign-in creates alice (cookie set, `GET /api/me` → handle `alice`, coords from `placeOf(1)`); `PATCH /api/me/profile` without `Origin` → 403; with it → 200; `POST /auth/dev` when `devLogin` is off (second hub instance) → 404.
  - device flow end to end: `POST /api/device/code` → pending (428) → `approve` with alice's cookie → `token` 200 with `hub_…` → second poll 410; `GET /api/me` with Bearer works and has no `tokens` field; `DELETE /api/me/tokens/self` → then 401.
  - `PUT /api/me/system` with Bearer: valid projection → `{ ok, seq, hash }`; `GET /api/systems/@alice` → `system` present and the JSON contains neither `balance` nor `today`; extra key → 422; older seq → 409 `stale`; a 600 KB body → 413; `PUT /api/me/status` → then `GET /api/me/status` with cookie returns it and `GET /api/systems/@alice` still has no `balance`; `GET /api/systems/at?x&y` finds alice.
  - orders: `POST /api/me/orders { kind: 'build', on: 'home', description: 'a moon' }` with cookie → 200; while it is pending, an SSE client with Bearer (`fetch` + reader) receives `event: order`; a second order → 409; `GET /api/me/orders?status=pending` with Bearer → 1; `POST /api/me/orders/<id>/done { ok: true, caption: 'A moon' }` with Bearer → 200 and the stream gets `order_done`; pending → 0.
  - `GET /api/me/events?t=…` with a token in the query → 401.
- [ ] **Steps 2–4** (RED on module missing; implement; GREEN). Run `npm test` → green, output pristine.
- [ ] **Step 5: Commit** `feat(hub): the HTTP surface: sign-in, devices, systems, status, orders, events`

### Task 8: the hub website

**Files:** Create `hub/public/index.html`, `system.html`, `me.html`, `device.html`, `hub.js`, `hub.css`, `robots.txt`, `hub/README.md`, `hub/Dockerfile`. No automated test; manual verification.

**Interfaces:**
- Consumes: the API above; `AgentWorld.enter(system, { api: async () => ({ ok: false }), toast, readOnly: true })` from `/world.js`.
- Produces: `hub.js` → `window.Hub = { api(method, path, body) (same-origin, credentials, JSON, `{ ok:false, error }` on failure), me() (cached `GET /api/me` or null), events(onEvent) (EventSource on `/api/me/events`) }`.

- [ ] **Step 1: Pages.** `index.html`: one headline ("A universe your agents' work builds"), a handle search box (`/@<handle>` on submit), sign-in button → `/login/github` (hidden when `GET /api/me` says signed in, then "Your system" → `/@handle`, and `/me`). `system.html`: the `#world` skeleton copied from `public/index.html` lines 823-890 (ids kept; the spend boxes may stay in the markup since `w-readonly` hides them), a profile card above the side panel (avatar, name, @handle, `x, y`, bio, link, `Level N · Stage`, `Active N days · M colonies · B builds`, `Joined <month year>`), the top bar's credit element removed, "Back to board" replaced by a link to `/`; on load: `GET /api/systems/@handle` (handle from the path), 404 → "No system by that name."; `AgentWorld.enter(system, { readOnly: true, ... })`; if `GET /api/me` is this account: show the **Owner** section (Task 11 fills its controls; here: "Your Mac keeps this up to date. Last synced <relative time>."). `me.html`: profile form (handle, name, bio, link, visibility, show friends) → `PATCH`, identities list, devices list with Revoke, Sign out. `device.html`: reads `?code=`, shows it in an input, "Approve"/"Deny" buttons (`POST /api/device/approve { user_code, label: 'Agent Panel on a Mac' }`), requires sign-in (link to `/login/github?return_to=/device?code=…`). `hub.css`: the panel's palette (dark, `--panel`, amber accent), system font stack, 13" friendly. `robots.txt`: allow `/` and `/@*`, disallow `/api/`, `/me`, `/device`.
- [ ] **Step 2: README and Dockerfile.** `hub/README.md`: run locally (`HUB_DEV_LOGIN=1 node --no-warnings=ExperimentalWarning hub/server.mjs`), env table, GitHub OAuth App setup (callback `<publicUrl>/auth/github/callback`), Caddy two-liner, backup (`cp data/hub.sqlite`), Node 22.13+. `hub/Dockerfile`: `node:22-alpine`, copy `world.mjs`, `public/world.js`, `hub/`, `CMD ["node", "--no-warnings=ExperimentalWarning", "hub/server.mjs"]`, volume `/data`, `HUB_DATA=/data`.
- [ ] **Step 3: Verify by hand.** Start the hub with dev login on 4848; `curl -X POST -H 'content-type: application/json' -H 'origin: http://127.0.0.1:4848' -d '{"login":"alice"}' -c c.txt http://127.0.0.1:4848/auth/dev`; open `/`, `/me` (edit bio), `/@alice` (shows "No system yet" state gracefully: `system === null` → the canvas shows a bare Home at level 1 and the card says "Nothing synced yet"), `/device?code=XXXX-XXXX` with a real code from `POST /api/device/code` → approve → poll returns a token. Screenshots of `/@alice` and `/me` in the report.
- [ ] **Step 4: Commit** `feat(hub): the website: universe landing, a system by handle, your profile, device approval`

## Part B: the Mac

### Task 9: `hub.mjs`, the hub client on the Mac

**Files:** Create `hub.mjs`; Test `test/hub-client.test.mjs`.

**Interfaces:**
- Produces: `DEFAULT_HUB = 'http://127.0.0.1:4848'` (placeholder until hosted); `parseSse(buffer: string): { events: [{ event, data }], rest: string }` (pure; `data` JSON-parsed when possible); `createHub({ file, hubUrl = process.env.ACP_HUB ?? DEFAULT_HUB, fetch = globalThis.fetch, now = Date.now })` →
  - `status(): { url, loggedIn, account: { id, handle, x, y } | null, pending: { userCode, verificationUri, expiresAt } | null, device }`.
  - `request(method, path, { body, timeout = 8000 } = {}): Promise<{ ok, status, body }>` — adds the bearer, `AbortSignal.timeout`, JSON in/out, never throws (`{ ok: false, status: 0, body: { error: 'Hub unreachable.' } }`); a 401 clears `loggedIn` until the file changes.
  - `startDeviceLogin(): Promise<{ ok, userCode, verificationUri, expiresAt, interval } | { ok: false, error }>` (saves `pending` in the file), `pollDeviceLogin(): Promise<'pending' | 'ok' | 'expired' | 'denied' | 'error'>` (on `ok` saves `token` + `account`, clears `pending`), `cancelDeviceLogin()`, `logout()` (`DELETE /api/me/tokens/self` best effort, then deletes the file).
  - `saveSync({ seq, hash, at })` writes `lastSync` into the file; `lastSync(): { seq, hash, at } | null`.
  - `stream(path, onEvent, { signal }): Promise<void>` — `fetch` with a streaming body, feeds `parseSse`, calls `onEvent(event, data)`, reconnects with backoff 2 s → 60 s until `signal` aborts; resolves when aborted.
  - The file (`hub.json`): `{ v: 1, url, device: <uuid>, token, account, lastSync: { seq, hash, at }, pending }`, mode 0o600, tmp+rename; re-read when its mtime changes (`statSync` per `status()`/`request()`).
- [ ] **Step 1: Tests** with a fake `fetch` (records calls; programmable responses) and a temp file: `parseSse` across partial chunks and multi-line data; `startDeviceLogin` saves `pending`; polling sequence `[428, 428, 200]` ends logged in with the token in the file at mode 0600 and never in `status()`; `request` sends `Authorization: Bearer`, times out → `{ ok:false, status:0 }`, a 401 flips `loggedIn()` to false and a rewritten file (newer mtime) flips it back; `logout` deletes the file and called `DELETE /api/me/tokens/self`; `stream` with a fake streaming response delivers two events then stops when aborted.
- [ ] **Steps 2–4.** - [ ] **Step 5: Commit** `feat(panel): the hub client: credentials, requests, the device sign-in, the event stream`

### Task 10: `hub-sync.mjs` and `hub-orders.mjs`

**Files:** Create `hub-sync.mjs`, `hub-orders.mjs`; Test `test/hub-sync.test.mjs`, `test/hub-orders.test.mjs`.

**Interfaces:**
- Consumes: `createHub` (Task 9), `publicProjection`, `validProjection`.
- Produces `createHubSync({ hub, projection: () => summary | null, status: () => ownerStatus, now = Date.now, timers = { setTimeout, clearTimeout }, log = console.error })`:
  - `schedule({ urgent = false } = {})`, `flush(): Promise<void>`, `state(): { lastOk: number | null, lastError: string | null, nextAt: number | null, pending: boolean }`, `stop()`.
  - Rules: debounce 10 s (urgent 1 s); `flush` computes `validProjection(publicProjection(summary))` — null → `lastError = 'The world could not be projected; nothing was sent.'`, no PUT; sha256 of the JSON equal to `lastSync.hash` and the heartbeat (30 min) not due → skip; else `PUT /api/me/system { pv, seq: now(), device, snapshot }` then `PUT /api/me/status`; success saves `lastSync` through `hub.saveSync({ seq, hash, at })` (add that method to Task 9's client) and clears `lastError`; 409 `stale` → `lastError = 'Another Mac is syncing this account.'` and the push is still counted as done; 422 → `lastError = <the hub's sentence>` and no retry until the projection hash changes; network failure or 5xx → backoff 30 s, 60, 120 … 600 s; 401 → `lastError = 'Sign in again.'` and stop until `hub.status().loggedIn` is true again; nothing when not logged in or when `projection()` is null. Never throws; `schedule()` returns synchronously.
- Produces `createHubOrders({ hub, execute: (order) => Promise<{ ok, error?, caption? }>, onDone, now, timers })`:
  - `start()`, `stop()`, `state(): { running, listening, current: order | null }`.
  - On `start`: fetch `GET /api/me/orders?status=pending`, run each in sequence through `execute`, `POST /api/me/orders/:id/done` with the result, call `onDone(order, result)`; then open `hub.stream('/api/me/events', …)` and on `order` events run the same way; refetch pending on every (re)connect; never run two orders at once; an `execute` that throws reports `{ ok: false, error: 'The Mac could not run it: <message>' }`.
- [ ] **Step 1: Tests** — `hub-sync` with a fake hub (`{ status, request, saveSync }` recording calls) and fake timers (`tick(ms)`): three `schedule()`s within 10 s → one PUT system + one PUT status; equal hash → no PUT; changed projection → PUT; hub down → `lastError`, retry after 30 s then 60 s; 422 → `lastError` is the hub's sentence and `tick(3600_000)` yields no retry, then a changed projection PUTs again; 409 stale → the message and `lastSync` saved; 401 → `'Sign in again.'` and no PUT until `loggedIn` flips; heartbeat after 30 min with an equal hash → PUT. `hub-orders` with a fake hub whose `request` returns one pending order and whose `stream` emits one `order` event: both executed in order, both reported `done`, `onDone` called twice, a throwing `execute` reports `ok:false`.
- [ ] **Steps 2–4.** - [ ] **Step 5: Commit** `feat(panel): sync the public projection and the owner's status; run the site's orders`

### Task 11: `server.mjs` wiring, `cli.mjs login|logout|status`, and `GET /world`

**Files:** Modify `server.mjs` (world block ~1340-1400, `snapshot()` ~1435, `ACTIONS` ~1560, `/events` connect/close ~1525-1545, page route ~1515), `cli.mjs`; Test `test/hub-server.test.mjs` (integration, spawns the server against a real local hub from Task 7).

**Interfaces:**
- Produces in `server.mjs`:
  - `hub = createHub({ file: path.join(path.dirname(PREFS), 'hub.json') })`; `ownerStatus()` → `{ balance, prices, today, home: { xp, today }, building, mac: { name: os.hostname(), online: true } }` from `worldSummary()`; `hubSync = createHubSync({ hub, projection: worldSummary, status: ownerStatus })`; `hubOrders = createHubOrders({ hub, execute: (o) => o.kind === 'build' ? buildInWorld(o) : buyInWorld(o), onDone: () => { hubSync.schedule({ urgent: true }); broadcast(); } })`.
  - `scanWorld` → `hubSync.schedule()` after each scan; `buyInWorld`/`buildInWorld`/`openWorld` → `schedule({ urgent: true })`; `hubOrders.start()` whenever `hub.status().loggedIn` (at boot, after login) and `stop()` on logout.
  - `snapshot().hub = { url, loggedIn, account, pending, sync: hubSync.state(), orders: hubOrders.state() }` (never the token).
  - `ACTIONS`: `/api/hub/status` → `{ ok, hub }`; `/api/hub/login/start` → `{ ok, userCode, verificationUri, expiresAt }` and a background poll loop at the hub's interval until `ok`/`expired`/`denied` (then `broadcast()`); `/api/hub/login/cancel`; `/api/hub/logout`; `/api/hub/profile { bio, link, name }` (proxy `PATCH /api/me/profile`? no: that is web-only; instead the panel edits bio/link through `PATCH /api/me/profile` is refused for tokens by the spec → the panel's Edit profile sends the user to `<hub>/me` instead; so **no** `/api/hub/profile` in this slice **(call)**); `/api/hub/sync` → `flush()` then `{ ok, sync }`.
  - `GET /world`: serves the same page with `__ACP_VIEW__` replaced by `world` (and `/` replaces it by `board`); the page reads it and calls `enterWorld()` on load when `world`.
- `cli.mjs`: `login` (device flow: prints `Open <verification_uri_complete> and enter <user_code>`, tries `open` on the URL, polls, prints `Signed in as @handle. Your system is at <x>, <y>.`), `logout`, `status` (hub login state + daemon status line); usage grows to `node server.mjs daemon install|remove|status | login | logout | status`.
- [ ] **Step 1: Integration test** — start a hub (`createHub` with dev login, port 0) in-process; spawn `server.mjs` with `ACP_HUB=http://127.0.0.1:<hubPort>`, `ACP_PREFS` in a temp dir, `ACP_DAEMON=1`; pre-write a `hub.json` with a token minted directly through the hub's `auth.mintToken` for a dev account (so no device flow is needed in this test) → within 15 s the hub's `GET /api/systems/@alice` has a `system` (World opened at boot, projected, pushed); then place an order through the hub (`POST /api/me/orders { kind: 'frontier', ang: 0 }` with the dev cookie) → within 15 s `GET /api/me/orders` shows it `failed` with the Mac's own sentence `It costs 4,000 credit, and you have 0.` (a fresh World has no credit; the point is the round trip); `GET /world` on the panel returns the page with `__ACP_VIEW__` resolved to `world`; `node server.mjs nonsense` still prints the usage with the new commands.
- [ ] **Steps 2–4.** - [ ] **Step 5: Commit** `feat(panel): sign in to the hub, keep it in sync, run its orders; a world-only view`

### Task 12: the panel's Profile section and the site's Owner controls

**Files:** Modify `public/index.html` (World side panel ~835-890, CSS ~455-510, `enterWorld` ~2474, `es.onmessage` ~1052), `public/world.js` (`enter`/`update` options, a `showHub(h)`), `hub/public/system.html`, `hub/public/hub.js`. Manual verification.

- [ ] **Step 1: Panel.** New first section in `#w-side`, exactly the spec's "Profile section": signed-out → the sentence "Sign in with GitHub to put your system on the universe map, visit others, and send rockets to friends. Only the shape of your world is shared, never your repositories, lines or credit." and **Sign in with GitHub** (→ `/api/hub/login/start`, then show `Enter <code> at <link>` with the link opening `verification_uri_complete`, "Waiting…", Cancel); signed-in → avatar (only `avatars.githubusercontent.com`, else initials), `@handle`, `x, y`, a link "Your page" → `<hub>/@handle`, "Edit profile" → `<hub>/me`, the sync line (`Synced 2 min ago` / `Hub unreachable, last synced …` / `Another Mac is syncing this account.` / `Sign in again.` / the hub's 422 sentence), an orders line when one is running ("Running an order from the site: build on Home…"), Sign out. `AgentWorld.enter(summary, { api, toast, hub })` and `update(summary, hub)`; `connect()` passes `snap.hub`. Toast when `sync.lastError` appears or clears, and when an order lands ("Built from the site: <caption>").
- [ ] **Step 2: Site.** In `system.html`, when the viewer is the owner: the **Owner** box shows `balance` and prices from `GET /api/me/status`, "Last synced …", and three controls mirroring the panel's: Push (compass select → `POST /api/me/orders { kind:'frontier', ang }`), Rocket (select of bare planets from the projection + name → `{ kind:'rocket', planet, name }`), Build (textarea ≤ 300 → `{ kind:'build', on, description }`, `on` = the place the view is at, Home or a colony's planet id); a pending order shows "On its way to your Mac…" and, via `Hub.events`, flips to the result or the Mac's refusal sentence; when `status.mac.online` is false or `status` is older than 10 minutes: "Your Mac hasn't picked this up yet. The service runs it as soon as the Mac is awake."
- [ ] **Step 3: Verify by hand.** Hub on 4848 with dev login; panel on 4799 with `ACP_HUB=http://127.0.0.1:4848` and a temp `ACP_PREFS`; sign in from the panel (dev hub: approve at `/device` after `POST /auth/dev` with curl); the profile card fills; `http://127.0.0.1:4848/@<handle>` shows the system; place a build order on the site with a seeded balance (write `tokens` for today into the temp `world.json` before starting the panel so the balance covers 4,000) → the panel toasts "Built from the site: …" and the site shows the caption; stop the hub → the panel says "Hub unreachable"; `GET /world` opens straight into World. Screenshots in the report.
- [ ] **Step 4: Commit** `feat(world): your profile and sign-in in the side panel; spend from your page on the hub`

### Task 13: docs

**Files:** Modify `README.md` (a new "Hub" section after "World": sign in, what is shared, the site, orders, `ACP_HUB`, world-only view; Security bullets: the token file, bearer, no CORS, what leaves the Mac), `install.sh` Done text (one line: "Sign in to the hub with `node server.mjs login` to put your system on the universe map").

- [ ] **Step 1: Write them in the README's voice.** - [ ] **Step 2: Commit** `docs: the hub, sign-in, and what leaves your Mac`

## Verification for the whole plan

- `npm test` green with pristine output; `grep -c ExperimentalWarning` on the output is 0.
- Review Focus 1–5 pinned by Tasks 9/10 (422 stops retries, 409 message), 4 (collect once), 7 (Host/Origin), 10 (pending fetched on connect).
- Task 8 and Task 12 manual sequences run against a local hub and a panel on a spare port with a temp `ACP_PREFS`; screenshots attached to the reports.
- Privacy check: `sqlite3 <tmp>/hub.sqlite 'select snapshot from systems'` contains no `/Users`, `tokens`, `credit`, `balance`, `added`, `description`; `select status from statuses` is served only with the owner's cookie or token.
