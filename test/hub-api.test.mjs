// The hub's HTTP surface, over a real socket: who may call what (cookie, token, neither), the same-origin and Host checks,
// sign-in, the device flow, uploads and what a stranger can read back, orders and the live stream. Each test is
// self-contained (it signs alice in again, which is idempotent) but they share one hub. Run with `npm test`.
process.env.TZ = 'UTC';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, publicProjection, PROJECTION_VERSION } from '../world.mjs';
import { createHub } from '../hub/server.mjs';
import { loadConfig } from '../hub/config.mjs';
import { placeOf } from '../hub/coords.mjs';
import { RATES } from '../hub/limits.mjs';

// The shared hubs run with limits too loose to trip: these tests sign alice in dozens of times on a frozen clock. The
// documented rates are exercised on hubs of their own, below.
const LOOSE = Object.fromEntries(Object.keys(RATES).map((k) => [k, [100_000, 60_000]]));

const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 12, 9, 0), at = (d) => T0 + d * DAY, key = (ms) => new Date(ms).toISOString().slice(0, 10);
// The same fixture as test/hub-systems.test.mjs (each test file carries its own).
function seeded({ tokens = {}, lines = {}, purchases = [], now = at(0) } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens, lines, repos: [], purchases }));
  return { world: createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => now }) };
}
const PUSH = { kind: 'frontier', at: at(0), price: 4000, earnedAt: 0, ang: 0 };
const ROCKET = { kind: 'rocket', at: at(1), price: 8000, earnedAt: 0, planet: 'p0', name: 'Vesta' };
const BUILD = { kind: 'build', at: at(2), price: 4000, earnedAt: 0, on: 'home', description: 'a ring city', caption: 'A ring city', pieces: [{ kind: 'ring_city', colour: '#ffc56a', size: 'large', place: 'equator', count: 4 }] };
function projection() {
  const tokens = {}, lines = { '/Users/someone/repo': {} };
  for (let d = 0; d < 21; d++) { tokens[key(at(d))] = 2_000_000; lines['/Users/someone/repo'][key(at(d))] = { added: 300, removed: 20, commits: 3 }; }
  return publicProjection(seeded({ tokens, lines, purchases: [PUSH, ROCKET, BUILD], now: at(21) }).world.summary());
}
const STATUS = () => ({
  balance: 1234.5, prices: { frontier: 4000, rocket: 8000, build: 4000 },
  today: { credit: 900, commits: 3, added: 300, removed: 20, tokens: 2_000_000, multiplier: 1.5 },
  home: { xp: 410, today: 12 }, building: false, mac: { name: 'Studio', online: true },
});

const ORIGIN = 'http://127.0.0.1';
let clock = Date.UTC(2026, 9, 22, 12, 0);
const now = () => clock;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-api-'));
let hub, port, off, offPort;

before(async () => {
  hub = createHub(loadConfig({ HUB_DATA: tmp(), HUB_DEV_LOGIN: '1', HUB_PUBLIC_URL: ORIGIN }), { now, rates: LOOSE });
  ({ port } = await hub.listen(0, '127.0.0.1'));
  // A second hub: no dev login, GitHub configured, and a fake `fetch` standing in for github.com.
  off = createHub(loadConfig({ HUB_DATA: tmp(), HUB_PUBLIC_URL: ORIGIN, HUB_GITHUB_CLIENT_ID: 'cid', HUB_GITHUB_CLIENT_SECRET: 'sec' }), {
    now, rates: LOOSE,
    fetch: async (url) => {
      const body = String(url).includes('access_token') ? { access_token: 'gho_x' } : { id: 4242, login: 'octo', avatar_url: 'https://avatars.githubusercontent.com/u/4242' };
      return { ok: true, json: async () => body };
    },
  });
  ({ port: offPort } = await off.listen(0, '127.0.0.1'));
});
after(async () => { await hub.close(); await off.close(); });

/** One request. `host` is 127.0.0.1 unless a test says otherwise; returns the status, parsed JSON, raw text and headers. */
async function call(method, p, { body, cookie, cookieRaw, token, origin, host = '127.0.0.1', on = port, raw, xff } = {}) {
  const headers = { host };
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  if (cookie) headers.cookie = `hub_s=${cookie}`;
  if (cookieRaw) headers.cookie = cookieRaw;
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers['content-type'] = 'application/json';
  // node:http rather than fetch, which will not send a Host other than the address it connects to.
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: on, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ res, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  let json = null; try { json = JSON.parse(r.text); } catch { /* not json */ }
  const h = r.res.headers;
  return { status: r.res.statusCode, json, text: r.text, headers: { get: (k) => (k === 'set-cookie-all' ? h['set-cookie'] : h[k.toLowerCase()]) ?? null }, setCookie: h['set-cookie']?.[0] ?? null };
}
const cookieOf = (r) => /hub_s=([^;]+)/.exec(r.setCookie ?? '')?.[1] ?? null;
/** Dev sign-in as a user; returns the session id. */
async function login(name = 'alice') {
  const r = await call('POST', '/auth/dev', { body: { login: name }, origin: ORIGIN });
  assert.equal(r.status, 200);
  return cookieOf(r);
}
/** A client token for a signed-in user, minted straight from the auth module. */
const tokenFor = async (name = 'alice') => hub.auth.mintToken(hub.auth.sessionAccountId(await login(name)), { label: 'test' }).token;

test('healthz answers; a wrong or missing Host is refused before anything else', async () => {
  const ok = await call('GET', '/healthz');
  assert.deepEqual([ok.status, ok.json], [200, { ok: true, v: 1 }]);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await call('GET', '/healthz', { host: `127.0.0.1:${port}` })).status, 200, 'the bound port is accepted too');
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`]) {
    const r = await call('GET', '/healthz', { host });
    assert.deepEqual([r.status, r.json], [421, { ok: false, error: 'Wrong host.' }], host);
  }
});

test('dev sign-in makes alice with her permanent spot and a session cookie; profile writes need the Origin', async () => {
  const r = await call('POST', '/auth/dev', { body: { login: 'alice' }, origin: ORIGIN });
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /^hub_s=[^;]+; HttpOnly; Path=\/; SameSite=Lax; Max-Age=2592000$/, 'plain http: no Secure');
  assert.equal(r.json.account.handle, 'alice');
  const cookie = cookieOf(r);
  assert.equal((await call('POST', '/auth/dev', { body: { login: 'alice' } })).status, 403, 'a cross-site form post is refused');

  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.account.handle, 'alice');
  assert.deepEqual([me.json.account.x, me.json.account.y], [placeOf(1).x, placeOf(1).y]);
  assert.deepEqual(me.json.identities, [{ provider: 'dev', login: 'alice' }]);
  assert.deepEqual([me.json.tokens, me.json.status, me.json.orders], [[], null, []]);

  const body = { name: 'Alice A' };
  const noOrigin = await call('PATCH', '/api/me/profile', { cookie, body });
  assert.deepEqual([noOrigin.status, noOrigin.json.ok], [403, false]);
  const patched = await call('PATCH', '/api/me/profile', { cookie, body, origin: ORIGIN });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.account.name, 'Alice A');
  const refused = await call('PATCH', '/api/me/profile', { cookie, body: { visibility: 'secret' }, origin: ORIGIN });
  assert.deepEqual([refused.status, refused.json.ok], [422, false], "the profile module's refusal keeps its status");
  assert.equal((await call('PATCH', '/api/me/profile', { body, origin: ORIGIN })).status, 401, 'no cookie: sign in first');
});

test('without a dev login the route is a 404; GitHub sign-in redirects, exchanges and signs in', async () => {
  const dev = await call('POST', '/auth/dev', { body: { login: 'mallory' }, origin: ORIGIN, on: offPort });
  assert.deepEqual([dev.status, dev.json.error], [404, 'Dev sign-in is off on this hub.']);
  const none = await call('GET', '/login/github');
  assert.deepEqual([none.status, none.json.error], [404, 'GitHub sign-in is not configured on this hub.']);
  assert.equal((await call('GET', '/auth/github/callback?code=c&state=s')).status, 404);

  const bad = await call('GET', '/auth/github/callback?code=c&state=nope', { on: offPort });
  assert.deepEqual([bad.status, bad.json.error], [400, 'That sign-in link has expired; try again.']);

  const go = await call('GET', '/login/github?return_to=/me', { on: offPort });
  assert.equal(go.status, 302);
  const to = new URL(go.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/auth/github/callback`);
  const state = to.searchParams.get('state');
  assert.equal(go.setCookie, `hub_oauth=${state}; HttpOnly; Path=/auth/github; SameSite=Lax; Max-Age=600`, 'the state is tied to this browser');

  // A valid state without the browser's cookie (the login-CSRF link an attacker forwards) signs nobody in and spends the cookie.
  const forged = await call('GET', `/auth/github/callback?code=c&state=${state}`, { on: offPort });
  assert.deepEqual([forged.status, forged.json.error], [400, 'That sign-in link has expired; try again.']);
  assert.equal(forged.setCookie, 'hub_oauth=; HttpOnly; Path=/auth/github; SameSite=Lax; Max-Age=0');
  assert.equal((await call('GET', `/auth/github/callback?code=c&state=${state}`, { on: offPort, cookieRaw: 'hub_oauth=other' })).status, 400, 'a different cookie is no better');

  const done = await call('GET', `/auth/github/callback?code=c&state=${state}`, { on: offPort, cookieRaw: `hub_oauth=${state}` });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/me');
  assert.ok(cookieOf(done));
  assert.equal((await call('GET', '/api/me', { cookie: cookieOf(done), on: offPort })).json.account.handle, 'octo');
  assert.equal(done.headers.get('set-cookie-all').at(-1), 'hub_oauth=; HttpOnly; Path=/auth/github; SameSite=Lax; Max-Age=0');
  assert.equal((await call('GET', `/auth/github/callback?code=c&state=${state}`, { on: offPort, cookieRaw: `hub_oauth=${state}` })).status, 400, 'a state is good once');
});

test('the device flow: a code, the pending poll, the owner approves, the Mac gets a token once, and can revoke it', async () => {
  const cookie = await login();
  const code = await call('POST', '/api/device/code');
  assert.equal(code.status, 200);
  const { device_code, user_code } = code.json;
  assert.equal(code.json.verification_uri, `${ORIGIN}/device`);
  assert.equal(code.json.verification_uri_complete, `${ORIGIN}/device?code=${user_code}`);
  assert.deepEqual([code.json.expires_in, code.json.interval], [900, 5]);

  const pending = await call('POST', '/api/device/token', { body: { device_code } });
  assert.deepEqual([pending.status, pending.json], [428, { ok: false, error: 'authorization_pending' }]);
  const approveBody = { user_code, label: 'Studio' };
  assert.equal((await call('POST', '/api/device/approve', { body: approveBody, origin: ORIGIN })).status, 401);
  assert.equal((await call('POST', '/api/device/approve', { body: approveBody, cookie })).status, 403);
  assert.equal((await call('POST', '/api/device/approve', { body: { user_code: 'BCDF-GHJK' }, cookie, origin: ORIGIN })).json.ok, false);
  assert.equal((await call('POST', '/api/device/approve', { body: approveBody, cookie, origin: ORIGIN })).status, 200);

  clock += 6000;
  const got = await call('POST', '/api/device/token', { body: { device_code } });
  assert.equal(got.status, 200);
  assert.match(got.json.token, /^hub_/);
  const a = got.json.account;
  assert.deepEqual(a, { id: a.id, handle: 'alice', x: placeOf(1).x, y: placeOf(1).y, name: a.name, avatar: null });
  clock += 6000;
  const again = await call('POST', '/api/device/token', { body: { device_code } });
  assert.deepEqual([again.status, again.json], [410, { ok: false, error: 'expired' }], 'the token is handed out once');

  const token = got.json.token;
  const me = await call('GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal('tokens' in me.json, false, 'a token never lists tokens');
  assert.equal((await call('GET', '/api/me', { cookie })).json.tokens.some((t) => t.label === 'Studio'), true);
  assert.equal((await call('DELETE', '/api/me/tokens/self', { cookie, origin: ORIGIN })).status, 403, 'self is for tokens');
  assert.equal((await call('DELETE', '/api/me/tokens/self', { token })).status, 200);
  assert.equal((await call('GET', '/api/me', { token })).status, 401);
});

test('a token can be revoked by id from the web; a device code can be denied; polling too fast is told to slow down', async () => {
  const cookie = await login();
  const mine = (await call('GET', '/api/me', { cookie })).json.tokens;
  const id = hub.auth.mintToken(hub.accounts.byHandle('alice').id, { label: 'spare' }).id;
  assert.equal((await call('DELETE', `/api/me/tokens/${id}`, { cookie })).status, 403, 'needs the Origin');
  assert.equal((await call('DELETE', `/api/me/tokens/${id}`, { cookie, origin: ORIGIN })).status, 200);
  assert.equal((await call('DELETE', `/api/me/tokens/${id}`, { cookie, origin: ORIGIN })).status, 404);
  assert.equal((await call('GET', '/api/me', { cookie })).json.tokens.length, mine.length);

  const a = (await call('POST', '/api/device/code')).json;
  assert.equal((await call('POST', '/api/device/deny', { body: { user_code: a.user_code }, origin: ORIGIN })).status, 401);
  assert.equal((await call('POST', '/api/device/deny', { body: { user_code: a.user_code }, cookie, origin: ORIGIN })).status, 200);
  assert.equal((await call('POST', '/api/device/deny', { body: { user_code: a.user_code }, cookie, origin: ORIGIN })).status, 404, 'a code is refused once');
  assert.equal(hub.db.prepare('SELECT account_id FROM device_codes WHERE user_code = ?').get(a.user_code).account_id, hub.accounts.byHandle('alice').id, 'who refused it is kept');
  const approved = (await call('POST', '/api/device/code')).json;
  assert.equal((await call('POST', '/api/device/approve', { body: { user_code: approved.user_code }, cookie, origin: ORIGIN })).status, 200);
  assert.equal((await call('POST', '/api/device/deny', { body: { user_code: approved.user_code }, cookie, origin: ORIGIN })).status, 404, 'an approved code cannot be refused');
  clock += 6000;
  assert.deepEqual((await call('POST', '/api/device/token', { body: { device_code: a.device_code } })).json, { ok: false, error: 'denied' });
  const b = (await call('POST', '/api/device/code')).json;
  await call('POST', '/api/device/token', { body: { device_code: b.device_code } });
  const fast = await call('POST', '/api/device/token', { body: { device_code: b.device_code } });
  assert.deepEqual([fast.status, fast.json.error], [429, 'slow_down']);
  assert.equal((await call('POST', '/api/device/token', { body: { device_code: 'nope' } })).status, 404);
});

test('a system and a status upload; strangers read the system and never the status', async () => {
  const cookie = await login();
  const token = await tokenFor();
  const snapshot = projection();
  const up = (seq, snap = snapshot) => call('PUT', '/api/me/system', { token, body: { pv: PROJECTION_VERSION, seq, device: 'Studio', snapshot: snap } });

  assert.equal((await call('PUT', '/api/me/system', { cookie, origin: ORIGIN, body: {} })).status, 403, 'uploads are for tokens');
  assert.equal((await call('PUT', '/api/me/system', { body: {} })).status, 401);
  const ok = await up(5);
  assert.deepEqual([ok.status, ok.json.ok, ok.json.seq, typeof ok.json.hash], [200, true, 5, 'string']);
  const pub = await call('GET', '/api/systems/@alice');
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('cache-control'), 'public, max-age=30');
  assert.ok(pub.json.system);
  assert.equal(pub.json.profile.handle, 'alice');
  assert.doesNotMatch(pub.text, /balance|today/);
  assert.equal((await call('GET', '/api/systems/@ALICE')).status, 200, 'a handle is case-insensitive');

  const extra = await up(6, { ...snapshot, extra: 1 });
  assert.deepEqual([extra.status, extra.json.ok], [422, false]);
  const stale = await up(4);
  assert.deepEqual([stale.status, stale.json.error], [409, 'stale']);
  const huge = await call('PUT', '/api/me/system', { token, raw: JSON.stringify({ pad: 'x'.repeat(600 * 1024) }) });
  assert.deepEqual([huge.status, huge.json], [413, { ok: false, error: 'That is too large.' }]);
  assert.equal((await call('PUT', '/api/me/status', { token, raw: JSON.stringify({ pad: 'x'.repeat(20 * 1024) }) })).status, 413, 'a status is capped at 16 KB');

  assert.equal((await call('PUT', '/api/me/status', { token, body: { balance: 'lots' } })).status, 422);
  assert.equal((await call('PUT', '/api/me/status', { token, body: STATUS() })).status, 200);
  assert.deepEqual((await call('GET', '/api/me/status', { cookie })).json, { ok: true, status: STATUS() });
  assert.equal((await call('GET', '/api/me/status')).status, 401);
  assert.doesNotMatch((await call('GET', '/api/systems/@alice')).text, /balance|1234/);

  const { x, y } = placeOf(1);
  const found = await call('GET', `/api/systems/at?x=${x}&y=${y}`);
  assert.equal(found.status, 200);
  assert.equal(found.json.profile.handle, 'alice');
  assert.equal((await call('GET', '/api/systems/at?x=99999&y=1')).status, 404);
  assert.equal((await call('GET', '/api/systems/at?x=a&y=1')).status, 404);
  const nobody = await call('GET', '/api/systems/@nobody');
  assert.deepEqual([nobody.status, nobody.json.error], [404, 'No system by that name.']);
});

/** Reads an SSE response until `re` shows up in what has arrived, or fails after two seconds. */
async function until(stream, re) {
  const deadline = Date.now() + 2000;
  while (!re.test(stream.text)) {
    assert.ok(Date.now() < deadline, `waiting for ${re}, got ${JSON.stringify(stream.text)}`);
    let timer;
    const { value, done } = await Promise.race([stream.reader.read(), new Promise((r) => { timer = setTimeout(() => r({ done: true }), 2000); })]);
    clearTimeout(timer);
    if (done) break;
    stream.text += stream.decoder.decode(value, { stream: true });
  }
  assert.match(stream.text, re);
}

test('orders: placed on the web, pushed to the Mac over the stream, reported done; one at a time', async () => {
  const cookie = await login();
  const token = await tokenFor();
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/me/events`, { headers: { host: '127.0.0.1', authorization: `Bearer ${token}` }, signal: ac.signal });
  try {
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const stream = { reader: res.body.getReader(), decoder: new TextDecoder(), text: '' };
    await until(stream, /retry: 2000/);

    const order = { kind: 'build', on: 'home', description: 'a moon' };
    assert.equal((await call('POST', '/api/me/orders', { cookie, body: order })).status, 403, 'needs the Origin');
    assert.equal((await call('POST', '/api/me/orders', { token, body: order })).status, 403, 'a token does not place orders');
    const placed = await call('POST', '/api/me/orders', { cookie, body: order, origin: ORIGIN });
    assert.equal(placed.status, 200);
    assert.deepEqual([placed.json.ok, placed.json.order.status, placed.json.order.description], [true, 'pending', 'a moon']);
    await until(stream, /event: order\ndata: .*"description":"a moon"/);

    const second = await call('POST', '/api/me/orders', { cookie, body: order, origin: ORIGIN });
    assert.deepEqual([second.status, second.json.ok], [409, false]);
    assert.equal((await call('POST', '/api/me/orders', { cookie, body: { kind: 'nope' }, origin: ORIGIN })).status, 422);

    const pend = await call('GET', '/api/me/orders?status=pending', { token });
    assert.equal(pend.json.orders.length, 1);
    assert.equal((await call('GET', '/api/me/orders?limit=0', { cookie })).json.orders.length, 1, 'the limit is clamped to at least 1');
    assert.equal((await call('GET', '/api/me/orders')).status, 401);

    const id = placed.json.order.id;
    assert.equal((await call('POST', `/api/me/orders/${id}/done`, { cookie, origin: ORIGIN, body: { ok: true } })).status, 403);
    const done = await call('POST', `/api/me/orders/${id}/done`, { token, body: { ok: true, caption: 'A moon' } });
    assert.deepEqual([done.status, done.json], [200, { ok: true }]);
    await until(stream, /event: order_done\ndata: .*"caption":"A moon"/);
    assert.equal((await call('POST', `/api/me/orders/${id}/done`, { token, body: { ok: true } })).status, 404, 'an order is done once');
    assert.equal((await call('GET', '/api/me/orders?status=pending', { token })).json.orders.length, 0);
    const all = await call('GET', '/api/me/orders', { token });
    assert.deepEqual([all.json.orders.length, all.json.orders[0].status, all.json.orders[0].result.caption], [1, 'done', 'A moon']);
  } finally {
    ac.abort();
  }
});

test('a Mac claims an order before running it: the first claim wins, a second is 409, and the winner reports it done', async () => {
  const cookie = await login('dora');
  const [one, two] = [await tokenFor('dora'), await tokenFor('dora')];
  const stranger = await tokenFor('erin');
  const placed = await call('POST', '/api/me/orders', { cookie, body: { kind: 'frontier', ang: 0 }, origin: ORIGIN });
  const { id } = placed.json.order;
  const path = `/api/me/orders/${id}/claim`;
  assert.equal((await call('POST', path, { cookie, origin: ORIGIN, body: {} })).status, 403, 'claims are for the Mac');
  assert.equal((await call('POST', path, { token: stranger, body: { device: 'theirs' } })).status, 404, 'not their order');
  const won = await call('POST', path, { token: one, body: { device: 'mac-one' } });
  assert.deepEqual([won.status, won.json.ok, won.json.order.id, won.json.order.status], [200, true, id, 'running']);
  const lost = await call('POST', path, { token: two, body: { device: 'mac-two' } });
  assert.deepEqual([lost.status, lost.json.ok], [409, false]);
  assert.equal((await call('POST', path, { token: one, body: { device: 'mac-one' } })).status, 409, 'a claim is granted once');
  assert.equal((await call('GET', '/api/me/orders?status=pending', { token: two })).json.orders.length, 0, 'a running order is not pending');
  assert.equal(hub.db.prepare('SELECT device FROM orders WHERE id = ?').get(id).device, 'mac-one');
  assert.equal((await call('POST', '/api/me/orders', { cookie, body: { kind: 'frontier', ang: 1 }, origin: ORIGIN })).status, 409, 'still one at a time');
  const done = await call('POST', `/api/me/orders/${id}/done`, { token: one, body: { ok: true, caption: 'Pushed' } });
  assert.deepEqual([done.status, done.json], [200, { ok: true }]);
  assert.equal((await call('GET', '/api/me/orders?limit=1', { cookie })).json.orders[0].status, 'done');
});

test('the event stream takes a Bearer header or the cookie, never a token in the address', async () => {
  const token = await tokenFor();
  const viaQuery = await call('GET', `/api/me/events?t=${token}`);
  assert.deepEqual([viaQuery.status, viaQuery.json], [401, { ok: false, error: 'Sign in first.' }]);
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/me/events`, { headers: { host: '127.0.0.1', cookie: `hub_s=${await login()}` }, signal: ac.signal });
  assert.equal(res.status, 200);
  ac.abort();
});

/** An open event stream as a token or a cookie; `ended` resolves true once the hub ends it. */
async function openStream({ token, cookie }) {
  const ac = new AbortController();
  const headers = { host: '127.0.0.1', ...(token && { authorization: `Bearer ${token}` }), ...(cookie && { cookie: `hub_s=${cookie}` }) };
  const res = await fetch(`http://127.0.0.1:${port}/api/me/events`, { headers, signal: ac.signal });
  assert.equal(res.status, 200);
  const stream = { reader: res.body.getReader(), decoder: new TextDecoder(), text: '', abort: () => ac.abort() };
  await until(stream, /retry: 2000/);
  stream.ended = (async () => {
    for (;;) {
      const { value, done } = await stream.reader.read();
      if (done) return true;
      stream.text += stream.decoder.decode(value, { stream: true });
    }
  })().catch(() => false);
  return stream;
}
const within = (p, ms = 2000) => Promise.race([p, new Promise((r) => setTimeout(() => r('timed out'), ms))]);

test('revoking a token or signing a session out ends the streams they opened, and nothing later reaches them', async () => {
  const cookie = await login();
  const alice = hub.accounts.byHandle('alice').id;
  const self = hub.auth.mintToken(alice, { label: 'self' });
  const byId = hub.auth.mintToken(alice, { label: 'by id' });
  const kept = hub.auth.mintToken(alice, { label: 'kept' });
  const tab = await login();
  const streams = await Promise.all([openStream({ token: self.token }), openStream({ token: byId.token }), openStream({ token: kept.token }), openStream({ cookie: tab })]);
  const [a, b, c, web] = streams;
  let stillOpen = c.ended;
  try {
    assert.equal((await call('DELETE', '/api/me/tokens/self', { token: self.token })).status, 200);
    assert.equal(await within(a.ended), true, 'the stream of a token revoked by itself ends');
    assert.equal((await call('DELETE', `/api/me/tokens/${byId.id}`, { cookie, origin: ORIGIN })).status, 200);
    assert.equal(await within(b.ended), true, 'the stream of a token revoked from the web ends');
    assert.equal((await call('POST', '/logout', { cookie: tab, origin: ORIGIN })).status, 200);
    assert.equal(await within(web.ended), true, 'the stream of a session signed out ends');
    hub.live.emit(alice, 'order', { id: 'after' });
    assert.equal(await within(stillOpen, 300), 'timed out', 'the token nobody revoked keeps its stream');
    assert.match(c.text, /"id":"after"/);
    for (const s of [a, b, web]) assert.doesNotMatch(s.text, /after/);
  } finally {
    for (const s of streams) s.abort();
  }
});

test('logout deletes the session and clears the cookie; the Bearer token wins when both are sent', async () => {
  const cookie = await login('carol');
  const token = await tokenFor('alice');
  const both = await call('GET', '/api/me', { cookie, token });
  assert.equal(both.json.account.handle, 'alice', 'the token decides, and so there is no tokens list');
  assert.equal('tokens' in both.json, false);

  assert.equal((await call('POST', '/logout', { cookie })).status, 403);
  const out = await call('POST', '/logout', { cookie, origin: ORIGIN });
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /^hub_s=; .*Max-Age=0/);
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
});

test('bodies must be JSON objects; unknown paths and missing pages are 404; the shared script is served', async () => {
  const token = await tokenFor();
  const bad = await call('PUT', '/api/me/status', { token, raw: '{nope' });
  assert.deepEqual([bad.status, bad.json], [400, { ok: false, error: 'The body is not JSON.' }]);
  assert.equal((await call('PUT', '/api/me/status', { token, raw: '[1]' })).status, 400);
  assert.equal((await call('PUT', '/api/me/status', { token, raw: 'null' })).status, 400);

  assert.equal((await call('GET', '/nowhere')).status, 404);
  assert.equal((await call('GET', '/..%2F..%2Fpackage.json')).status, 404, 'only fixed names are served');
  assert.equal((await call('GET', '/api/systems/@a%zz')).status, 404, 'a bad escape is not a crash');
  const page = await call('GET', '/');
  assert.deepEqual([page.status, page.headers.get('x-frame-options')], [200, 'DENY'], 'a page is never framed');
  assert.equal((await call('GET', '/@alice')).headers.get('x-frame-options'), 'DENY');
  // The pages link the shared files with their content's version, and the current version is kept for good.
  const v = /href="\/hub\.css\?v=([0-9a-f]{10})"/.exec(page.text)?.[1];
  assert.ok(v, 'the landing links the stylesheet with a version');
  assert.match(page.text, /src="\/hub\.js\?v=[0-9a-f]{10}"/);
  assert.match((await call('GET', '/@alice')).text, /src="\/world\.js\?v=[0-9a-f]{10}"/);
  assert.equal((await call('GET', `/hub.css?v=${v}`)).headers.get('cache-control'), 'public, max-age=31536000, immutable', 'the current version never needs asking about');
  assert.equal((await call('GET', '/hub.css?v=0000000000')).headers.get('cache-control'), 'no-cache', 'a stale version is checked like a bare request');
  assert.equal((await call('GET', '/hub.css')).headers.get('cache-control'), 'no-cache');
  assert.equal((await call('GET', `/hub.css?v=${v}`)).text, (await call('GET', '/hub.css')).text, 'the same file either way');
  const download = await call('GET', '/download');
  assert.deepEqual([download.status, download.headers.get('x-frame-options')], [200, 'DENY']);
  assert.match(download.text, /\.\/install\.sh/, 'the download page carries the install lines');
  assert.doesNotMatch(page.text, /href="\/me"[^>]*>Your profile/, 'the landing\'s bar has no profile link; the galaxy page has it');
  assert.equal((await call('GET', '/healthz')).headers.get('x-frame-options'), null, 'JSON answers are as they were');
  const js = await call('GET', '/world.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(js.headers.get('cache-control'), 'no-cache', 'kept, but asked about on every load');
  assert.match(js.headers.get('etag'), /^"[A-Za-z0-9_-]{22}"$/);
  assert.equal(js.text, fs.readFileSync(new URL('../public/world.js', import.meta.url), 'utf8'));
  const same = await fetch(`http://127.0.0.1:${port}/world.js`, { headers: { 'if-none-match': js.headers.get('etag') } });
  assert.equal(same.status, 304, 'an unchanged file is not sent again');
  const other = await fetch(`http://127.0.0.1:${port}/world.js`, { headers: { 'if-none-match': '"something-else"' } });
  assert.equal(other.status, 200, 'a changed file is');
  assert.equal(page.headers.get('cache-control'), 'no-cache', 'pages too');
});

/** A hub with the documented limits, on its own port, for one test; closed by the test. */
async function strictHub(env = {}) {
  const h = createHub(loadConfig({ HUB_DATA: tmp(), HUB_DEV_LOGIN: '1', HUB_PUBLIC_URL: ORIGIN, ...env }), { now });
  const { port: on } = await h.listen(0, '127.0.0.1');
  return { on, close: () => h.close() };
}

test('limits: the sixth device code in a minute is refused with a wait, as JSON; a minute later it is minted again', async () => {
  const { on, close } = await strictHub();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/device/code', { on })).status, 200, `code ${i + 1}`);
    const no = await call('POST', '/api/device/code', { on });
    assert.equal(no.status, 429);
    assert.match(no.headers.get('retry-after'), /^\d+$/);
    assert.ok(Number(no.headers.get('retry-after')) >= 1);
    assert.deepEqual(no.json, { ok: false, error: `Too many requests; try again in ${no.headers.get('retry-after')} seconds.` });
    clock += 60_000;
    assert.equal((await call('POST', '/api/device/code', { on })).status, 200);
  } finally { await close(); }
});

test('limits: behind a trusted proxy the last forwarded address is the visitor; without trust the header is ignored', async () => {
  const trusted = await strictHub({ HUB_TRUST_PROXY: '1' });
  try {
    const signin = (xff) => call('POST', '/auth/dev', { on: trusted.on, body: { login: 'alice' }, origin: ORIGIN, xff });
    for (let i = 0; i < 10; i++) assert.equal((await signin('1.1.1.1')).status, 200, `sign-in ${i + 1}`);
    assert.equal((await signin('1.1.1.1')).status, 429, 'that address has had its ten');
    assert.equal((await signin('2.2.2.2')).status, 200, 'another address has not');
    assert.equal((await signin('9.9.9.9, 1.1.1.1')).status, 429, 'the last entry is the proxy\'s own, the rest is what the visitor claims');
    assert.equal((await signin('2.2.2.2, ')).status, 200, 'a trailing empty entry is skipped: this is 2.2.2.2 again');
    for (let i = 0; i < 8; i++) assert.equal((await signin('2.2.2.2')).status, 200);
    assert.equal((await signin('2.2.2.2')).status, 429, 'and 2.2.2.2 has now had its ten');
    assert.equal((await signin('')).status, 200, 'an empty header falls back to the socket');
    assert.equal((await signin(' , ')).status, 200, 'so does one with only blank entries');
    // One visitor holds a whole IPv6 /64: addresses in it share a bucket, the next /64 has its own.
    for (let i = 0; i < 10; i++) assert.equal((await signin(`2a01:4f8:1:2:${i}:${i}:${i}:${i}`)).status, 200);
    assert.equal((await signin('2a01:4f8:1:2:ffff::1')).status, 429, 'the same /64 is the same visitor');
    assert.equal((await signin('2a01:4f8:1:3::1')).status, 200, 'the next /64 is not');
  } finally { await trusted.close(); }
  const plain = await strictHub();
  try {
    const signin = (xff) => call('POST', '/auth/dev', { on: plain.on, body: { login: 'alice' }, origin: ORIGIN, xff });
    for (let i = 0; i < 10; i++) assert.equal((await signin(`10.0.0.${i}`)).status, 200);
    assert.equal((await signin('10.0.0.99')).status, 429, 'every one of them came from 127.0.0.1');
  } finally { await plain.close(); }
});

test('limits: a refused write changes nothing, and the limit is per account, not per address', async () => {
  const { on, close } = await strictHub();
  try {
    const cookie = cookieOf(await call('POST', '/auth/dev', { on, body: { login: 'alice' }, origin: ORIGIN }));
    const other = cookieOf(await call('POST', '/auth/dev', { on, body: { login: 'bob' }, origin: ORIGIN }));
    for (let i = 0; i < 10; i++) assert.equal((await call('PATCH', '/api/me/profile', { on, cookie, origin: ORIGIN, body: { bio: `b${i}` } })).status, 200);
    const late = await call('PATCH', '/api/me/profile', { on, cookie, origin: ORIGIN, body: { bio: 'late' } });
    assert.equal(late.status, 429);
    assert.equal((await call('GET', '/api/me', { on, cookie })).json.account.bio, 'b9', 'the eleventh edit did not land');
    assert.equal((await call('PATCH', '/api/me/profile', { on, cookie: other, origin: ORIGIN, body: { bio: 'mine' } })).status, 200, 'bob, from the same address, is not limited by alice');
  } finally { await close(); }
});

test('an unlisted galaxy is reached by its link only: noindex on its page and API answer, and not found by coordinates', async () => {
  const cookie = await login('bob');
  const me = (await call('GET', '/api/me', { cookie })).json.account;
  assert.equal((await call('PATCH', '/api/me/profile', { cookie, origin: ORIGIN, body: { visibility: 'unlisted' } })).status, 200);
  const api = await call('GET', '/api/systems/@bob');
  assert.deepEqual([api.status, api.headers.get('x-robots-tag')], [200, 'noindex']);
  const page = await call('GET', '/@bob');
  assert.deepEqual([page.status, page.headers.get('x-robots-tag')], [200, 'noindex']);
  assert.equal((await call('GET', `/api/systems/at?x=${me.x}&y=${me.y}`)).status, 404, 'a scan of the map does not find it');
  assert.equal((await call('PATCH', '/api/me/profile', { cookie, origin: ORIGIN, body: { visibility: 'public' } })).status, 200);
  assert.equal((await call('GET', '/@bob')).headers.get('x-robots-tag'), null, 'public again: nothing added');
  assert.equal((await call('GET', '/api/systems/@bob')).headers.get('x-robots-tag'), null);
  assert.equal((await call('GET', `/api/systems/at?x=${me.x}&y=${me.y}`)).json.profile.handle, 'bob');
  assert.equal((await call('GET', '/@nobody-here')).headers.get('x-robots-tag'), null, 'an unknown handle is the plain shell');
});
