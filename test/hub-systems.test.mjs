// The hub's copy of each developer's system, the owner-only status beside it, and the orders the Mac will execute.
// Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, publicProjection, PROJECTION_VERSION } from '../world.mjs';
import { openDb } from '../hub/db.mjs';
import { createAccounts } from '../hub/accounts.mjs';
import { createSystems } from '../hub/systems.mjs';
import { createOrders, ORDER_TTL_MS } from '../hub/orders.mjs';

const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 12, 9, 0), at = (d) => T0 + d * DAY, key = (ms) => new Date(ms).toISOString().slice(0, 10);
// The same fixture as test/world-projection.test.mjs (each test file carries its own).
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

const T = Date.UTC(2026, 9, 22, 12, 0);
let db, clock, accounts, systems, orders, account, ids;
const fresh = () => {
  clock = T; ids = 0;
  db = openDb(':memory:');
  accounts = createAccounts(db, { now: () => clock });
  systems = createSystems(db, { now: () => clock });
  orders = createOrders(db, { now: () => clock, random: () => `order-${++ids}` });
  account = accounts.signIn({ provider: 'github', subject: '1', login: 'alice' }).account;
};
const upload = (snapshot, seq = 1, extra = {}) => ({ pv: PROJECTION_VERSION, seq, device: 'Studio', snapshot, ...extra });
const STATUS = () => ({
  balance: 1234.5, prices: { frontier: 4000, rocket: 8000, build: 4000 },
  today: { credit: 900, commits: 3, added: 300, removed: 20, tokens: 2_000_000, multiplier: 1.5 },
  home: { xp: 410, today: 12 }, building: false, mac: { name: 'Studio', online: true },
});

test('a valid system is stored, canonicalised, and read back with what was derived from it', () => {
  fresh();
  const p = projection();
  const r = systems.put(account.id, upload(p, 5));
  assert.equal(r.ok, true);
  assert.equal(r.seq, 5);
  assert.equal(r.hash, crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex'));
  const got = systems.get(account.id);
  assert.deepEqual(got.snapshot, p);
  assert.deepEqual(
    [got.level, got.stage, got.daysWorked, got.colonies, got.builds, got.receivedAt],
    [p.home.level, p.home.stage, 21, 1, 1, T],
  );
  assert.equal(systems.get('nobody'), null);
});

test('the same system again is unchanged but says the Mac is there; an older seq is stale and names the stored one', () => {
  fresh();
  const p = projection();
  systems.put(account.id, upload(p, 5));
  const before = { ...db.prepare('SELECT hash, snapshot FROM systems WHERE account_id = ?').get(account.id) };
  clock = T + 3 * DAY;
  const again = systems.put(account.id, upload(p, 6));
  assert.deepEqual([again.ok, again.unchanged, again.seq], [true, true, 6]);
  assert.equal(systems.get(account.id).receivedAt, T + 3 * DAY, 'the heartbeat moves received_at');
  assert.equal(systems.publicView(account, systems.get(account.id)).stats.lastActive, '2026-10-25');
  assert.deepEqual({ ...db.prepare('SELECT hash, snapshot FROM systems WHERE account_id = ?').get(account.id) }, before, 'and nothing else');
  const stale = systems.put(account.id, upload(p, 4));
  assert.deepEqual(stale, { ok: false, status: 409, error: 'stale', seq: 6 }, 'an unchanged upload still moves the stored seq forward');
});

test('a different system with the same seq is newer, not stale', () => {
  fresh();
  const p = projection(), q = { ...projection(), daysActive: 22 };
  systems.put(account.id, upload(p, 5));
  const r = systems.put(account.id, upload(q, 5));
  assert.equal(r.ok, true);
  assert.equal(systems.get(account.id).daysWorked, 22);
});

test('a snapshot the validator refuses is a 422 and nothing changes', () => {
  fresh();
  const p = projection();
  systems.put(account.id, upload(p, 1));
  const before = systems.get(account.id);
  for (const bad of [{ ...p, balance: 99 }, null, 'text', { ...p, pv: 2 }]) {
    assert.deepEqual(systems.put(account.id, upload(bad, 2)), { ok: false, status: 422, error: 'The system could not be read; nothing was stored.' });
  }
  assert.equal(systems.put(account.id, upload(p, 'x')).status, 422);
  assert.equal(systems.put(account.id, upload(p, Infinity)).status, 422);
  assert.equal(systems.put(account.id, { ...upload(p, 2), pv: 2 }).status, 422, 'the upload names another version');
  assert.deepEqual(systems.get(account.id), before);
  const bob = accounts.signIn({ provider: 'github', subject: '2', login: 'bob' }).account;
  assert.equal(systems.put(bob.id, upload({ ...p, extra: 1 })).ok, false);
  assert.equal(systems.get(bob.id), null);
});

test('what is stored is the validated copy, and a device that is not short text is dropped', () => {
  fresh();
  const p = projection();
  systems.put(account.id, upload(p, 1, { device: 'x'.repeat(101) }));
  assert.equal(db.prepare('SELECT device FROM systems WHERE account_id = ?').get(account.id).device, null);
  const q = { ...p, daysActive: 22 }, shuffled = Object.fromEntries(Object.entries(q).reverse());
  systems.put(account.id, upload(shuffled, 2, { device: 'Studio' }));
  assert.equal(db.prepare('SELECT device FROM systems WHERE account_id = ?').get(account.id).device, 'Studio');
  assert.equal(db.prepare('SELECT snapshot FROM systems WHERE account_id = ?').get(account.id).snapshot, JSON.stringify(q));
});

test('the owner status is shape-checked, stored as a copy, and read back', () => {
  fresh();
  assert.equal(systems.getStatus(account.id), null);
  assert.deepEqual(systems.putStatus(account.id, { ...STATUS(), stray: 'x', mac: { name: ' Studio ', online: true, extra: 1 } }), { ok: true });
  assert.deepEqual(systems.getStatus(account.id), STATUS());
  const no = { ok: false, status: 422, error: 'The status could not be read; nothing was stored.' };
  const bad = (mutate) => { const s = STATUS(); mutate(s); assert.deepEqual(systems.putStatus(account.id, s), no); };
  bad((s) => { s.balance = '12'; });
  bad((s) => { s.balance = NaN; });
  bad((s) => { delete s.prices.rocket; });
  bad((s) => { s.prices.build = Infinity; });
  bad((s) => { s.today.tokens = '1'; });
  bad((s) => { delete s.home; });
  bad((s) => { s.building = 'no'; });
  bad((s) => { s.mac.name = 'x'.repeat(41); });
  bad((s) => { s.mac.online = 1; });
  assert.deepEqual(systems.putStatus(account.id, null), no);
  assert.deepEqual(systems.getStatus(account.id), STATUS(), 'a refused status leaves the stored one');
});

test('a public view carries the profile and the stats and never the owner status', () => {
  fresh();
  systems.putStatus(account.id, STATUS());
  const p = projection();
  systems.put(account.id, upload(p, 1));
  clock = T + 3 * DAY;
  const view = systems.publicView(accounts.byId(account.id), systems.get(account.id));
  assert.deepEqual(Object.keys(view), ['profile', 'stats', 'system']);
  assert.deepEqual(view.profile, { handle: 'alice', name: null, bio: null, link: null, avatar: null, x: account.x, y: account.y, joined: '2026-10-22', visibility: 'public' });
  assert.deepEqual(view.stats, { level: p.home.level, stage: p.home.stage, daysWorked: 21, colonies: 1, builds: 1, lastActive: '2026-10-22' });
  assert.deepEqual(view.system, p);
  const text = JSON.stringify(view);
  for (const word of ['balance', 'prices', 'multiplier', 'Studio', 'email', 'show_friends', 'showFriends', 'createdAt']) assert.equal(text.includes(word), false, `leaks ${word}`);
});

test('a public view of an account with no system shows a bare rock', () => {
  fresh();
  const view = systems.publicView(accounts.byId(account.id), null);
  assert.deepEqual(view.stats, { level: 1, stage: 'Bare rock', daysWorked: 0, colonies: 0, builds: 0, lastActive: null });
  assert.equal(view.system, null);
});

test('the three kinds of order are placed, pending, and read back in full', () => {
  fresh();
  const a = orders.place(account.id, { kind: 'frontier', ang: 1.5 });
  assert.deepEqual(a, { ok: true, order: { id: 'order-1', kind: 'frontier', ang: 1.5, status: 'pending', createdAt: T } });
  assert.deepEqual(orders.pending(account.id), [a.order]);
  orders.done(account.id, 'order-1', { ok: true });
  const r = orders.place(account.id, { kind: 'rocket', planet: 'p12', name: '  Vesta  ' });
  assert.deepEqual(r.order, { id: 'order-2', kind: 'rocket', planet: 'p12', name: 'Vesta', status: 'pending', createdAt: T });
  orders.done(account.id, 'order-2', { ok: true });
  const b = orders.place(account.id, { kind: 'build', on: 'home', description: '  a ring city  ', junk: 1 });
  assert.deepEqual(b.order, { id: 'order-3', kind: 'build', on: 'home', description: 'a ring city', status: 'pending', createdAt: T });
  orders.done(account.id, 'order-3', { ok: true });
  assert.equal(orders.place(account.id, { kind: 'build', on: 'p7', description: 'x'.repeat(300) }).ok, true);
});

test('a second order is refused while the last one is pending, for that account only', () => {
  fresh();
  orders.place(account.id, { kind: 'frontier', ang: 0 });
  assert.deepEqual(orders.place(account.id, { kind: 'frontier', ang: 1 }), { ok: false, status: 409, error: "One thing at a time: the last order hasn't landed yet." });
  const other = accounts.signIn({ provider: 'github', subject: '2', login: 'bob' }).account;
  assert.equal(orders.place(other.id, { kind: 'frontier', ang: 1 }).ok, true);
});

test('an order that is not well formed is a 422 and is not stored', () => {
  fresh();
  const bad = (body) => { const r = orders.place(account.id, body); assert.deepEqual([r.ok, r.status], [false, 422], JSON.stringify(body)); };
  bad({ kind: 'build', on: 'home', description: 'x'.repeat(301) });
  bad({ kind: 'build', on: 'home', description: '   ' });
  bad({ kind: 'build', on: 'home', description: 5 });
  bad({ kind: 'build', on: 'moon', description: 'x' });
  bad({ kind: 'build', on: 'p12345', description: 'x' });
  bad({ kind: 'rocket', planet: 'p0', name: 'no <script>' });
  bad({ kind: 'rocket', planet: 'p0', name: '' });
  bad({ kind: 'rocket', planet: 'home', name: 'Vesta' });
  bad({ kind: 'rocket', planet: 'p0\n', name: 'Vesta' });
  bad({ kind: 'frontier', ang: '1' });
  bad({ kind: 'frontier', ang: Infinity });
  bad({ kind: 'frontier' });
  bad({ kind: 'hail' });
  bad(null);
  assert.deepEqual(orders.list(account.id), []);
});

test('done marks the order and keeps only the allowed result; another account cannot finish it', () => {
  fresh();
  orders.place(account.id, { kind: 'frontier', ang: 0 });
  const other = accounts.signIn({ provider: 'github', subject: '2', login: 'bob' }).account;
  assert.deepEqual(orders.done(other.id, 'order-1', { ok: true }), { ok: false, status: 404, error: 'No such order.' });
  clock += 5000;
  assert.deepEqual(orders.done(account.id, 'order-1', { ok: true, caption: 'Pushed out', secret: 'no' }), { ok: true });
  assert.deepEqual(orders.pending(account.id), []);
  assert.deepEqual(orders.list(account.id), [{
    id: 'order-1', kind: 'frontier', ang: 0, status: 'done', createdAt: T, doneAt: T + 5000, result: { ok: true, caption: 'Pushed out' },
  }]);
  assert.equal(orders.done(account.id, 'order-1', { ok: true }).status, 404, 'a landed order cannot land again');
  orders.place(account.id, { kind: 'frontier', ang: 1 });
  orders.done(account.id, 'order-2', { ok: false, error: 'x'.repeat(400) });
  const failed = orders.list(account.id)[0];
  assert.deepEqual([failed.id, failed.status, failed.result.error.length], ['order-2', 'failed', 300]);
});

test('list is newest first and limited', () => {
  fresh();
  for (let i = 0; i < 3; i++) { orders.place(account.id, { kind: 'frontier', ang: i }); orders.done(account.id, `order-${i + 1}`, { ok: true }); clock += 1000; }
  assert.deepEqual(orders.list(account.id).map((o) => o.id), ['order-3', 'order-2', 'order-1']);
  assert.deepEqual(orders.list(account.id, 2).map((o) => o.id), ['order-3', 'order-2']);
});

test('an order not collected within a day expires, and the account can order again', () => {
  fresh();
  orders.place(account.id, { kind: 'frontier', ang: 0 });
  assert.equal(ORDER_TTL_MS, 86_400_000);
  clock = T + ORDER_TTL_MS - 1;
  assert.equal(orders.pending(account.id).length, 1);
  clock = T + ORDER_TTL_MS;
  assert.deepEqual(orders.pending(account.id), []);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-1').status, 'expired');
  assert.equal(orders.place(account.id, { kind: 'frontier', ang: 1 }).ok, true);
  assert.equal(orders.expire(T + 3 * ORDER_TTL_MS), 1);
  assert.equal(orders.expire(T + 3 * ORDER_TTL_MS), 0);
});

test('a claim moves an order to running once; done takes a running order; a stale running order expires', () => {
  fresh();
  orders.place(account.id, { kind: 'frontier', ang: 0 });
  const other = accounts.signIn({ provider: 'github', subject: '2', login: 'bob' }).account;
  assert.deepEqual(orders.claim(other.id, 'order-1', 'theirs'), { ok: false, status: 404, error: 'No such order.' });
  const won = orders.claim(account.id, 'order-1', 'Studio');
  assert.deepEqual([won.ok, won.order.id, won.order.status], [true, 'order-1', 'running']);
  assert.deepEqual(orders.claim(account.id, 'order-1', 'Laptop'), { ok: false, status: 409, error: 'That order is no longer waiting.' });
  assert.deepEqual({ ...db.prepare('SELECT device, claimed_at FROM orders WHERE id = ?').get('order-1') }, { device: 'Studio', claimed_at: T });
  assert.deepEqual(orders.pending(account.id), [], 'only pending orders are handed out');
  assert.equal(orders.place(account.id, { kind: 'frontier', ang: 1 }).status, 409, 'a running order is still the one out');
  assert.deepEqual(orders.done(account.id, 'order-1', { ok: true }), { ok: true });
  assert.equal(orders.list(account.id)[0].status, 'done');

  orders.place(account.id, { kind: 'frontier', ang: 2 });
  orders.claim(account.id, 'order-2', 'Studio');
  clock = T + ORDER_TTL_MS;
  assert.equal(orders.expire(), 1, 'a Mac that claimed it and never answered does not hold the account up for ever');
  assert.equal(orders.list(account.id)[0].status, 'expired');
  assert.equal(orders.done(account.id, 'order-2', { ok: true }).status, 404);
  assert.equal(orders.claim(account.id, 'order-2', 'Studio').status, 409);
  assert.equal(orders.place(account.id, { kind: 'frontier', ang: 3 }).ok, true);
});
