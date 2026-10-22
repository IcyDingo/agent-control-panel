// hub-sync: the public projection and the owner's status go to the hub when the World changes, quietly and never twice
// for nothing. Fake timers, a fake hub and a real seeded World. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, publicProjection, validProjection, PROJECTION_VERSION } from '../world.mjs';
import { createHubSync } from '../hub-sync.mjs';

const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 12, 9, 0), at = (d) => T0 + d * DAY, key = (ms) => new Date(ms).toISOString().slice(0, 10);
// The same fixture as test/hub-systems.test.mjs (each test file carries its own).
function seeded({ tokens = {}, lines = {}, purchases = [], now = at(0) } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens, lines, repos: [], purchases }));
  return createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => now });
}
const PUSH = { kind: 'frontier', at: at(0), price: 4000, earnedAt: 0, ang: 0 };
const ROCKET = { kind: 'rocket', at: at(1), price: 8000, earnedAt: 0, planet: 'p0', name: 'Vesta' };
function summary(purchases) {
  const tokens = {}, lines = { '/Users/someone/repo': {} };
  for (let d = 0; d < 21; d++) { tokens[key(at(d))] = 2_000_000; lines['/Users/someone/repo'][key(at(d))] = { added: 300, removed: 20, commits: 3 }; }
  return seeded({ tokens, lines, purchases, now: at(21) }).summary();
}

/** Timers that only move when told to; `tick` runs what falls due, in order, and lets async work finish. */
function clock(start = 1_000_000) {
  let now = start, next = 1;
  const queue = new Map();
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return {
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => { const id = next++; queue.set(id, { fn, at: now + ms }); return id; },
      clearTimeout: (id) => { queue.delete(id); },
    },
    waiting: () => queue.size,
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

function setup({ answers = {}, purchases = [PUSH], status = { balance: 1 } } = {}) {
  const c = clock();
  const calls = [], saves = [];
  const state = { loggedIn: true, sync: null, purchases, status, answers: { ...answers } };
  const hub = {
    status: () => ({ loggedIn: state.loggedIn, device: 'd1' }),
    lastSync: () => state.sync,
    saveSync: (s) => { state.sync = s; saves.push(s); return true; },
    request: async (method, p, { body } = {}) => {
      calls.push({ method, path: p, body });
      const a = state.answers[`${method} ${p}`];
      return a ?? { ok: true, status: 200, body: { ok: true } };
    },
  };
  const logs = [];
  const sync = createHubSync({ hub, projection: () => summary(state.purchases), status: () => state.status, now: c.now, timers: c.timers, log: (...a) => logs.push(a) });
  const puts = (p) => calls.filter((x) => x.path === p);
  return { c, calls, saves, state, hub, sync, logs, system: () => puts('/api/me/system'), statusPuts: () => puts('/api/me/status') };
}
const SYSTEM = 'PUT /api/me/system';

test('three schedules within ten seconds make one push of the system and one of the status', async () => {
  const t = setup();
  t.sync.schedule(); await t.c.tick(3000); t.sync.schedule(); await t.c.tick(3000); t.sync.schedule();
  assert.equal(t.system().length, 0);
  assert.equal(t.sync.state().pending, true);
  await t.c.tick(10_000);
  assert.equal(t.system().length, 1);
  assert.equal(t.statusPuts().length, 1);
  assert.deepEqual(t.statusPuts()[0].body, { balance: 1 });
  const { body } = t.system()[0];
  const valid = validProjection(publicProjection(summary([PUSH])));
  assert.equal(body.pv, PROJECTION_VERSION);
  assert.equal(body.device, 'd1');
  assert.equal(body.seq, t.saves[0].seq);
  assert.deepEqual(body.snapshot, valid);
  assert.equal(t.saves[0].hash, crypto.createHash('sha256').update(JSON.stringify(valid)).digest('hex'));
  assert.equal(t.sync.state().lastOk, t.saves[0].at);
  assert.equal(t.sync.state().lastError, null);
  assert.equal(t.sync.state().pending, false);
  assert.equal(t.sync.state().nextAt, null);
});

test('an urgent schedule shortens a pending wait, and a normal one never lengthens it', async () => {
  const t = setup();
  t.sync.schedule();
  t.sync.schedule({ urgent: true });
  t.sync.schedule();
  assert.equal(t.sync.state().nextAt, t.c.now() + 1000);
  await t.c.tick(1000);
  assert.equal(t.system().length, 1);
});

test('an equal projection is not sent again, a changed one is', async () => {
  const t = setup();
  await t.sync.flush();
  assert.equal(t.system().length, 1);
  await t.sync.flush();
  assert.equal(t.system().length, 1);
  t.state.purchases = [PUSH, ROCKET];
  await t.sync.flush();
  assert.equal(t.system().length, 2);
});

test('an equal projection is sent again once the half-hour heartbeat is due', async () => {
  const t = setup();
  await t.sync.flush();
  await t.c.tick(29 * 60_000);
  await t.sync.flush();
  assert.equal(t.system().length, 1);
  await t.c.tick(2 * 60_000);
  await t.sync.flush();
  assert.equal(t.system().length, 2);
});

test('two flushes at once make one push', async () => {
  const t = setup();
  await Promise.all([t.sync.flush(), t.sync.flush()]);
  assert.equal(t.system().length, 1);
});

test('nothing is sent when signed out or before the world has started, and the error is left alone', async () => {
  const t = setup();
  t.state.loggedIn = false;
  await t.sync.flush();
  const none = createHubSync({ hub: t.hub, projection: () => null, status: () => ({}), now: t.c.now, timers: t.c.timers });
  t.state.loggedIn = true;
  await none.flush();
  assert.equal(t.calls.length, 0);
  assert.equal(t.sync.state().lastError, null);
  assert.equal(none.state().lastError, null);
});

test('a world that cannot be projected sends nothing and says so', async () => {
  const t = setup();
  const bad = { ...summary([PUSH]), seed: -1 };
  const sync = createHubSync({ hub: t.hub, projection: () => bad, status: () => ({}), now: t.c.now, timers: t.c.timers });
  await sync.flush();
  assert.equal(t.calls.length, 0);
  assert.equal(sync.state().lastError, 'The world could not be projected; nothing was sent.');
});

test('a hub that is down is retried after 30 seconds, then 60, and a success clears the error and the backoff', async () => {
  const t = setup({ answers: { [SYSTEM]: { ok: false, status: 0, body: { error: 'Hub unreachable.' } } } });
  await t.sync.flush();
  assert.equal(t.sync.state().lastError, 'Hub unreachable.');
  assert.equal(t.sync.state().nextAt, t.c.now() + 30_000);
  await t.c.tick(29_000);
  assert.equal(t.system().length, 1);
  await t.c.tick(1000);
  assert.equal(t.system().length, 2);
  assert.equal(t.sync.state().nextAt, t.c.now() + 60_000);
  await t.c.tick(60_000);
  assert.equal(t.system().length, 3);
  assert.equal(t.sync.state().nextAt, t.c.now() + 120_000);
  delete t.state.answers[SYSTEM];
  await t.c.tick(120_000);
  assert.equal(t.system().length, 4);
  assert.equal(t.sync.state().lastError, null);
  assert.equal(t.sync.state().nextAt, null);
  t.state.sync = null; t.state.answers[SYSTEM] = { ok: false, status: 503, body: {} };
  await t.sync.flush();
  assert.equal(t.sync.state().nextAt, t.c.now() + 30_000);
});

test('the wait between retries stops growing at ten minutes, and the hub\'s own sentence on a 5xx is kept', async () => {
  const t = setup({ answers: { [SYSTEM]: { ok: false, status: 502, body: { error: 'Bad gateway.' } } } });
  await t.sync.flush();
  assert.equal(t.sync.state().lastError, 'Bad gateway.');
  for (const wait of [30, 60, 120, 240, 480, 600, 600]) {
    assert.equal(t.sync.state().nextAt, t.c.now() + wait * 1000, `${wait} s`);
    await t.c.tick(wait * 1000);
  }
});

test('a change made while the hub is down does not hurry the retry', async () => {
  const t = setup({ answers: { [SYSTEM]: { ok: false, status: 0, body: { error: 'Hub unreachable.' } } } });
  await t.sync.flush();
  t.sync.schedule({ urgent: true });
  assert.equal(t.sync.state().nextAt, t.c.now() + 30_000);
});

test('a refused projection says the hub may be another version, is not retried, and a changed one is sent again', async () => {
  const t = setup({ answers: { [SYSTEM]: { ok: false, status: 422, body: { ok: false, error: 'The system could not be read; nothing was stored.' } } } });
  await t.sync.flush();
  assert.equal(t.sync.state().lastError, 'The hub refused the system; it may be running a different version.');
  assert.equal(t.sync.state().nextAt, null);
  assert.equal(t.statusPuts().length, 0);
  await t.c.tick(3_600_000);
  await t.sync.flush();
  assert.equal(t.system().length, 1);
  t.state.purchases = [PUSH, ROCKET];
  await t.sync.flush();
  assert.equal(t.system().length, 2);
});

test('another Mac winning the race is said so, and the push still counts as done', async () => {
  const t = setup({ answers: { [SYSTEM]: { ok: false, status: 409, body: { ok: false, error: 'stale', seq: 9e15 } } } });
  await t.sync.flush();
  assert.equal(t.sync.state().lastError, 'Another Mac is syncing this account.');
  assert.equal(t.saves.length, 1);
  assert.equal(t.sync.state().lastOk, t.c.now());
  assert.equal(t.sync.state().nextAt, null);
  await t.sync.flush();
  assert.equal(t.system().length, 1);
});

test('a refused sign-in says to sign in again, retries nothing, and pushes once signed in', async () => {
  const t = setup({ answers: { [SYSTEM]: { ok: false, status: 401, body: { error: 'Sign in.' } } } });
  await t.sync.flush();
  assert.equal(t.sync.state().lastError, 'Sign in again.');
  assert.equal(t.sync.state().nextAt, null);
  t.state.loggedIn = false;
  await t.c.tick(3_600_000);
  t.sync.schedule();
  await t.c.tick(60_000);
  assert.equal(t.system().length, 1);
  delete t.state.answers[SYSTEM];
  t.state.loggedIn = true;
  t.sync.schedule();
  await t.c.tick(10_000);
  assert.equal(t.system().length, 2);
  assert.equal(t.sync.state().lastError, null);
});

test('a status the hub refuses is reported but does not undo the system push', async () => {
  const t = setup({ answers: { 'PUT /api/me/status': { ok: false, status: 422, body: { ok: false, error: 'Bad status.' } } } });
  await t.sync.flush();
  assert.equal(t.saves.length, 1);
  assert.equal(t.sync.state().lastError, 'Bad status.');
  assert.equal(t.sync.state().lastOk, t.c.now());
});

test('a thrown error is caught, logged once, and reported plainly', async () => {
  const t = setup();
  t.hub.request = async () => { throw new Error('boom'); };
  await t.sync.flush();
  assert.equal(t.sync.state().lastError, 'Sync failed.');
  assert.deepEqual(t.logs, [['hub sync failed:', 'boom']]);
  assert.equal(t.sync.state().pending, false);
});

test('stop clears the pending timer', async () => {
  const t = setup();
  t.sync.schedule();
  t.sync.stop();
  assert.equal(t.c.waiting(), 0);
  assert.equal(t.sync.state().pending, false);
  await t.c.tick(60_000);
  assert.equal(t.calls.length, 0);
});

test('a changed status is sent on its own, and an unchanged one with an unchanged projection sends nothing', async () => {
  const t = setup();
  await t.sync.flush();
  assert.equal(t.system().length, 1);
  assert.equal(t.statusPuts().length, 1);
  await t.sync.flush();
  assert.equal(t.calls.length, 2);
  t.state.status = { balance: 2 };
  await t.sync.flush();
  assert.equal(t.system().length, 1);
  assert.equal(t.statusPuts().length, 2);
  assert.deepEqual(t.statusPuts()[1].body, { balance: 2 });
  await t.sync.flush();
  assert.equal(t.calls.length, 3);
});

test('an unchanged status is sent again at the half-hour heartbeat', async () => {
  const t = setup();
  await t.sync.flush();
  await t.c.tick(31 * 60_000);
  await t.sync.flush();
  assert.equal(t.statusPuts().length, 2);
});

test('a status the hub did not take is tried again at the next flush, and its error clears once it is taken', async () => {
  const t = setup({ answers: { 'PUT /api/me/status': { ok: false, status: 0, body: { error: 'Hub unreachable.' } } } });
  await t.sync.flush();
  assert.equal(t.sync.state().lastError, 'Hub unreachable.');
  assert.equal(t.sync.state().nextAt, null);
  await t.sync.flush();
  assert.equal(t.statusPuts().length, 2);
  assert.equal(t.system().length, 1);
  delete t.state.answers['PUT /api/me/status'];
  await t.sync.flush();
  assert.equal(t.statusPuts().length, 3);
  assert.equal(t.sync.state().lastError, null);
});

test('a push that fails after stop arms nothing, and schedule and flush do nothing once stopped', async () => {
  const t = setup();
  let fail;
  t.hub.request = (method, p) => { t.calls.push({ method, path: p }); return new Promise((r) => { fail = () => r({ ok: false, status: 0, body: { error: 'Hub unreachable.' } }); }); };
  const pushing = t.sync.flush();
  await t.c.tick(0);
  t.sync.stop();
  fail();
  await pushing;
  assert.equal(t.sync.state().nextAt, null);
  assert.equal(t.c.waiting(), 0);
  assert.equal(t.sync.state().pending, false);
  t.sync.schedule({ urgent: true });
  assert.equal(t.c.waiting(), 0);
  await t.sync.flush();
  await t.c.tick(3_600_000);
  assert.equal(t.calls.length, 1);
});

test('a 429 from the hub is a pause, not a refusal: the same world is pushed again after the backoff', async () => {
  const t = setup({ answers: { [SYSTEM]: { ok: false, status: 429, body: { ok: false, error: 'Too many requests; try again in 7 seconds.' } } } });
  await t.sync.flush();
  assert.equal(t.sync.state().lastError, 'Too many requests; try again in 7 seconds.');
  assert.equal(t.sync.state().nextAt, t.c.now() + 30_000);
  delete t.state.answers[SYSTEM];
  await t.c.tick(30_000);
  assert.equal(t.system().length, 2, 'the unchanged world went again');
  assert.equal(t.sync.state().lastError, null);
});
