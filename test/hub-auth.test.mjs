// The hub's sign-in machinery: browser sessions, the tokens the desktop app holds, the device flow that hands it one,
// the short-lived OAuth state, and the GitHub exchange. Secrets must never sit in the database in clear.
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../hub/db.mjs';
import { createAccounts } from '../hub/accounts.mjs';
import { createAuth } from '../hub/auth.mjs';
import { authorizeUrl, exchange } from '../hub/github.mjs';

const T = 1_700_000_000_000, DAY = 24 * 3600 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
let db, auth, clock;

// A counter-based filler, so every code and token is reproducible and no two are alike.
function counterBytes() {
  let n = 0;
  return (size) => { n += 1; return Buffer.from(Uint8Array.from({ length: size }, (_, i) => (i === 0 ? n : i === 1 ? n >> 8 : n * 37 + i * 11) & 0xff)); };
}
function fresh() {
  clock = { t: T, add(ms) { this.t += ms; } };
  db = openDb(':memory:');
  const accounts = createAccounts(db, { now: () => clock.t, random: (() => { let i = 0; return () => `acct-${++i}`; })() });
  accounts.signIn({ provider: 'github', subject: '1', login: 'alice' });
  accounts.signIn({ provider: 'github', subject: '2', login: 'bob' });
  auth = createAuth(db, { now: () => clock.t, randomBytes: counterBytes() });
}

test('a session is found until it expires, and a deleted one is gone', () => {
  fresh();
  const id = auth.createSession('acct-1', 'Mozilla/5.0');
  assert.equal(auth.sessionAccountId(id), 'acct-1');
  const row = db.prepare('SELECT * FROM sessions').get();
  assert.notEqual(row.id_hash, id, 'the session id is not stored in clear');
  assert.equal(row.id_hash, sha256(id));
  assert.equal(row.expires_at - row.created_at, 30 * DAY);

  clock.add(30 * DAY - 1);
  assert.equal(auth.sessionAccountId(id), 'acct-1', 'still valid just before 30 days');
  clock.add(1);
  assert.equal(auth.sessionAccountId(id), null, 'gone at 30 days');

  const other = auth.createSession('acct-2');
  auth.deleteSession(other);
  assert.equal(auth.sessionAccountId(other), null);
  assert.equal(auth.sessionAccountId('not-a-session'), null);
  assert.equal(auth.sessionAccountId(undefined), null);
  assert.equal(row.ua, 'Mozilla/5.0');
  auth.createSession('acct-1', 'x'.repeat(500));
  assert.equal(Math.max(...db.prepare('SELECT length(ua) AS n FROM sessions').all().map((r) => r.n)), 200, 'the user agent is cut to 200');
});

test('a client token verifies, lists without its secret, and revokes by id or by itself', () => {
  fresh();
  const a = auth.mintToken('acct-1', { label: 'Mac', device: 'laptop' });
  const b = auth.mintToken('acct-1', { label: 'Phone', device: 'phone' });
  assert.match(a.token, /^hub_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.token, b.token);
  assert.equal(auth.tokenAccountId(a.token), 'acct-1');
  assert.equal(auth.tokenAccountId('hub_nonsense'), null);
  assert.equal(auth.tokenAccountId(undefined), null);

  const row = db.prepare('SELECT * FROM client_tokens WHERE id = ?').get(a.id);
  assert.equal(row.hash, sha256(a.token), 'only the hash is stored');
  assert.equal(row.scopes, 'client');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM client_tokens').all()).includes(a.token));

  clock.add(1000);
  const listed = auth.listTokens('acct-1');
  assert.equal(listed.length, 2);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['createdAt', 'device', 'id', 'label', 'lastUsedAt']);
  assert.ok(!JSON.stringify(listed).includes(a.token) && !JSON.stringify(listed).includes(row.hash));
  assert.deepEqual(auth.listTokens('acct-2'), []);

  // Used time moves at most once a minute.
  const lastUsed = () => db.prepare('SELECT last_used_at AS t FROM client_tokens WHERE id = ?').get(a.id).t;
  assert.equal(lastUsed(), T, 'set by the first use');
  clock.add(30_000); auth.tokenAccountId(a.token);
  assert.equal(lastUsed(), T, 'not bumped again within a minute');
  clock.add(31_000); auth.tokenAccountId(a.token);
  assert.equal(lastUsed(), clock.t, 'bumped after a minute');

  assert.equal(auth.revokeToken('acct-2', a.id), false, 'another account cannot revoke it');
  assert.equal(auth.tokenAccountId(a.token), 'acct-1');
  assert.equal(auth.revokeToken('acct-1', a.id), true);
  assert.equal(auth.tokenAccountId(a.token), null);
  assert.equal(auth.revokeToken('acct-1', a.id), false, 'already revoked');
  assert.deepEqual(auth.listTokens('acct-1').map((t) => t.label), ['Phone'], 'a revoked token drops off the list');

  assert.equal(auth.revokeByToken(b.token), true);
  assert.equal(auth.tokenAccountId(b.token), null);
  assert.equal(auth.revokeByToken(b.token), false);
  assert.equal(auth.revokeByToken('hub_nonsense'), false);
});

test('the device flow: pending → approved → collected once; expired; denied; slow_down', () => {
  fresh();
  const d = auth.startDevice();
  assert.match(d.user_code, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
  assert.deepEqual([d.expires_in, d.interval], [900, 5]);
  assert.notEqual(db.prepare('SELECT hash FROM device_codes').get().hash, d.device_code, 'the device code is stored hashed');
  assert.equal(auth.pollDevice(d.device_code).status, 'pending');
  assert.equal(auth.pollDevice(d.device_code).status, 'slow_down', 'polled again at once');
  assert.equal(db.prepare('SELECT interval FROM device_codes').get().interval, 10, 'and the interval grew by 5');
  clock.add(10_000);
  assert.equal(auth.approveDevice(d.user_code, 'acct-1', 'Agent Panel on a Mac').ok, true);
  const got = auth.pollDevice(d.device_code);
  assert.deepEqual([got.status, got.accountId, got.token.startsWith('hub_')], ['ok', 'acct-1', true]);
  assert.equal(auth.tokenAccountId(got.token), 'acct-1');
  assert.deepEqual(auth.listTokens('acct-1').map((t) => [t.label, t.device]), [['Agent Panel on a Mac', d.user_code]]);
  assert.equal(db.prepare('SELECT token_plain FROM device_codes').get().token_plain, null, 'the parked token is cleared');
  clock.add(10_000);
  assert.equal(auth.pollDevice(d.device_code).status, 'expired', 'collected once');

  const e = auth.startDevice(); clock.add(900_001); assert.equal(auth.pollDevice(e.device_code).status, 'expired');
  assert.equal(auth.approveDevice(e.user_code, 'acct-1', 'late').ok, false, 'an expired code cannot be approved');
  const f = auth.startDevice(); auth.denyDevice(f.user_code); clock.add(10_000); assert.equal(auth.pollDevice(f.device_code).status, 'denied');
  assert.equal(auth.pollDevice('nonsense').status, 'unknown');
  assert.equal(auth.approveDevice('XXXX-XXXX', 'acct-1', 'x').ok, false);

  // The user types the code however they like.
  const g = auth.startDevice();
  assert.equal(auth.approveDevice(g.user_code.toLowerCase().replace('-', ''), 'acct-1', 'typed').ok, true);
  assert.equal(auth.approveDevice(g.user_code, 'acct-1', 'again').ok, false, 'approved only once');
});

test('a link is an approved device code: one poll collects the token; a new link retires the old one and its token', () => {
  fresh();
  const a = auth.linkDevice('acct-1', 'Worker on a Mac');
  assert.equal(a.expires_in, 900);
  const row = db.prepare('SELECT user_code, status FROM device_codes WHERE account_id = ?').get('acct-1');
  assert.match(row.user_code, /^LINK-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
  assert.equal(row.status, 'approved');
  const b = auth.linkDevice('acct-1', 'Worker on a Mac');
  assert.deepEqual(auth.pollDevice(a.device_code), { status: 'expired' }, 'the first link is gone');
  const got = auth.pollDevice(b.device_code);
  assert.equal(got.status, 'ok');
  assert.equal(auth.tokenOwner(got.token).accountId, 'acct-1');
  assert.equal(auth.listTokens('acct-1').filter((t) => t.label === 'Worker on a Mac').length, 1, 'the retired link\'s token was revoked');
  assert.deepEqual(auth.pollDevice(b.device_code), { status: 'expired' }, 'collected once');
});

test('a link that is never collected is gone after fifteen minutes', () => {
  fresh();
  const { device_code } = auth.linkDevice('acct-1', 'Worker on a Mac');
  clock.add(900_001);
  assert.deepEqual(auth.pollDevice(device_code), { status: 'expired' });
});

test('an approved code nobody collects is revoked when it runs out, by a late poll or by the next start', () => {
  fresh();
  const parked = () => db.prepare('SELECT token_plain AS p FROM device_codes WHERE user_code = ?');
  const a = auth.startDevice();
  assert.equal(auth.approveDevice(a.user_code, 'acct-1', 'Mac').ok, true);
  const token = parked().get(a.user_code).p;
  assert.ok(token.startsWith('hub_'), 'the token waits in the row');
  assert.equal(auth.tokenAccountId(token), 'acct-1');
  assert.equal(auth.listTokens('acct-1').length, 1);

  clock.add(900_000);
  assert.equal(auth.pollDevice(a.device_code).status, 'expired');
  assert.equal(parked().get(a.user_code).p, null, 'the parked token is gone');
  assert.equal(auth.tokenAccountId(token), null, 'and the token no longer verifies');
  assert.deepEqual(auth.listTokens('acct-1'), [], 'listTokens leaves out revoked tokens');

  // Nobody polls at all: the next start sweeps it.
  const b = auth.startDevice();
  assert.equal(auth.approveDevice(b.user_code, 'acct-1', 'Mac').ok, true);
  const second = parked().get(b.user_code).p;
  clock.add(900_000);
  auth.startDevice();
  assert.equal(parked().get(b.user_code).p, null);
  assert.equal(auth.tokenAccountId(second), null);
  assert.equal(db.prepare('SELECT status FROM device_codes WHERE user_code = ?').get(b.user_code).status, 'expired');

  // Rows a day past their end are forgotten.
  clock.add(24 * 3600 * 1000);
  auth.startDevice();
  assert.deepEqual(db.prepare('SELECT user_code FROM device_codes WHERE user_code IN (?, ?)').all(a.user_code, b.user_code), []);
});

test('an oauth state is single-use, short-lived, and only keeps a local return path', () => {
  fresh();
  assert.deepEqual(auth.takeState(auth.newState('/@alice')), { returnTo: '/@alice' });
  assert.deepEqual(auth.takeState(auth.newState('https://evil.example')), { returnTo: null });
  assert.deepEqual(auth.takeState(auth.newState('//evil.example')), { returnTo: null });
  for (const sneaky of ['/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/\\/evil.example', '/ok\r\nSet-Cookie: x=1', '/.//evil.example', '/..//evil.example', '/a/..//evil.example']) {
    assert.deepEqual(auth.takeState(auth.newState(sneaky)), { returnTo: null }, JSON.stringify(sneaky));
  }
  assert.deepEqual(auth.takeState(auth.newState('/@alice?tab=map#top')), { returnTo: '/@alice?tab=map#top' });
  assert.deepEqual(auth.takeState(auth.newState(undefined)), { returnTo: null });
  const s = auth.newState('/x'); assert.ok(auth.takeState(s)); assert.equal(auth.takeState(s), null);
  const t = auth.newState('/x'); clock.add(600_001); assert.equal(auth.takeState(t), null);
  assert.equal(auth.takeState('never-issued'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n, 0, 'taken and expired states leave no rows');
});

test('github: the authorize url carries no scope; exchange returns the numeric id as subject or null', async () => {
  const url = new URL(authorizeUrl({ clientId: 'cid', state: 'st', redirectUri: 'https://h/auth/github/callback' }));
  assert.deepEqual([url.origin + url.pathname, url.searchParams.get('client_id'), url.searchParams.get('state'), url.searchParams.has('scope')], ['https://github.com/login/oauth/authorize', 'cid', 'st', false]);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://h/auth/github/callback');
  const calls = [];
  const fetch = async (u, init) => { calls.push([u, init?.headers?.Accept ?? init?.headers?.accept, init?.headers?.Authorization, init?.headers?.['User-Agent']]); return u.includes('access_token') ? { ok: true, json: async () => ({ access_token: 'gho_x' }) } : { ok: true, json: async () => ({ id: 42, login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/42' }) }; };
  assert.deepEqual(await exchange({ code: 'c', clientId: 'cid', clientSecret: 's', fetch }), { subject: '42', login: 'alice', avatar: 'https://avatars.githubusercontent.com/u/42' });
  assert.deepEqual(calls, [
    ['https://github.com/login/oauth/access_token', 'application/json', undefined, undefined],
    ['https://api.github.com/user', undefined, 'Bearer gho_x', 'agent-panel-hub'],
  ]);
  assert.equal(await exchange({ code: 'c', clientId: 'cid', clientSecret: 's', fetch: async () => ({ ok: false }) }), null);
  assert.equal(await exchange({ code: 'c', clientId: 'cid', clientSecret: 's', fetch: async () => { throw new Error('offline'); } }), null);
  assert.equal(await exchange({ code: 'c', clientId: 'cid', clientSecret: 's', fetch: async () => ({ ok: true, json: async () => ({ error: 'bad_verification_code' }) }) }), null);
});
