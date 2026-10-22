// hub-orders: orders placed on the hub's website are run on this Mac, one at a time, and reported back. A fake hub
// with a fake event stream and fake timers. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHubOrders } from '../hub-orders.mjs';
import { openDb } from '../hub/db.mjs';
import { createAccounts } from '../hub/accounts.mjs';
import { createOrders, RUNNING_TTL_MS } from '../hub/orders.mjs';

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const order = (id, extra = {}) => ({ id, kind: 'build', description: `build ${id}`, status: 'pending', createdAt: 1, ...extra });

/** A hub whose pending list is `pending`, whose stream hands `streamed` to the listener and then waits to be aborted. */
function setup({ pending = [], streamed = [], execute, onDone, onOpen, answers = [], doneAnswers = [], claimAnswers = [], endAtOnce = false, request } = {}) {
  const calls = [], done = [], extras = { fire: null, streams: 0, who: { loggedIn: true, account: { id: 'a1' } } };
  const timeouts = [];
  const hub = {
    status: () => extras.who,
    request: request ?? (async (method, path, { body } = {}) => {
      calls.push({ method, path, body });
      if (method === 'GET') return answers.shift() ?? { ok: true, status: 200, body: { ok: true, orders: pending } };
      if (path.endsWith('/claim')) return claimAnswers.shift() ?? { ok: true, status: 200, body: { ok: true } };
      const answer = doneAnswers.shift();
      if (answer) return answer;
      done.push({ id: path.split('/')[4], ...body });
      return { ok: true, status: 200, body: { ok: true } };
    }),
    stream: (path, onEvent, { signal, onOpen }) => new Promise((resolve) => {
      extras.streams++;
      extras.open = () => onOpen();
      extras.fire = (o) => onEvent('order', o);
      extras.end = resolve;   // as the real stream does once the Mac is signed out
      Promise.resolve().then(async () => { for (const o of streamed) await onEvent('order', o); });
      if (endAtOnce) resolve();   // as the real stream does when the hub answers 401
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  };
  const ran = [], dones = [];
  const orders = createHubOrders({
    hub,
    execute: execute ?? (async (o) => { ran.push(o.id); return { ok: true, caption: `did ${o.id}` }; }),
    onDone: onDone ?? ((o, r) => { dones.push([o.id, r]); }),
    onOpen,
    timers: { setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; }, clearTimeout: () => {} },
    log: () => {},
  });
  return { orders, hub, calls, done, ran, dones, extras, timeouts };
}

test('pending orders and then a streamed one run in order, are reported done, and reach onDone', async () => {
  const t = setup({ pending: [order('a')], streamed: [order('b')] });
  t.orders.start();
  await settle();
  assert.deepEqual(t.ran, ['a', 'b']);
  assert.deepEqual(t.done, [{ id: 'a', ok: true, caption: 'did a' }, { id: 'b', ok: true, caption: 'did b' }]);
  assert.deepEqual(t.dones.map(([id]) => id), ['a', 'b']);
  assert.deepEqual(t.dones[0][1], { ok: true, caption: 'did a' });
  assert.equal(t.calls[0].path, '/api/me/orders?status=pending');
  assert.deepEqual(t.orders.state(), { running: true, listening: true, current: null });
  t.orders.stop();
  await settle();
  assert.deepEqual(t.orders.state(), { running: false, listening: false, current: null });
});

test('an execute that throws is reported as a failure, and the next order still runs', async () => {
  const t = setup({
    pending: [order('a'), order('b')],
    execute: async (o) => { if (o.id === 'a') throw new Error('no claude'); return { ok: true }; },
  });
  t.orders.start();
  await settle();
  assert.deepEqual(t.done, [{ id: 'a', ok: false, error: 'The Mac could not run it: no claude' }, { id: 'b', ok: true }]);
  assert.equal(t.dones[0][1].ok, false);
  t.orders.stop();
});

test('two orders never run at once', async () => {
  let active = 0, most = 0;
  const t = setup({
    pending: [order('a')], streamed: [order('b'), order('c')],
    execute: async () => { active++; most = Math.max(most, active); await new Promise((r) => setImmediate(r)); active--; return { ok: true }; },
  });
  t.orders.start();
  await settle();
  assert.equal(most, 1);
  assert.deepEqual(t.done.map((d) => d.id), ['a', 'b', 'c']);
  t.orders.stop();
});

test('the order being run is visible while it runs', async () => {
  let release, seen;
  const t = setup({ pending: [order('a')], execute: () => new Promise((r) => { release = r; }) });
  t.orders.start();
  await settle();
  seen = t.orders.state().current;
  assert.equal(seen.id, 'a');
  release({ ok: true });
  await settle();
  assert.equal(t.orders.state().current, null);
  t.orders.stop();
});

test('an order seen twice (pending and streamed, or replayed) runs once', async () => {
  const t = setup({ pending: [order('a')], streamed: [order('a'), order('b')] });
  t.orders.start();
  await settle();
  t.extras.fire(order('b'));
  await settle();
  assert.deepEqual(t.ran, ['a', 'b']);
  assert.equal(t.done.length, 2);
  t.orders.stop();
});

test('an order that arrives over the stream while others were missed brings those in too', async () => {
  const t = setup({ pending: [], streamed: [] });
  t.orders.start();
  await settle();
  const missed = [order('x'), order('y')];
  t.hub.request = async (method, path, { body } = {}) => {
    if (method === 'GET') return { ok: true, status: 200, body: { ok: true, orders: missed } };
    if (path.endsWith('/claim')) return { ok: true, status: 200, body: { ok: true } };
    t.done.push({ id: path.split('/')[4], ...body });
    return { ok: true, status: 200, body: { ok: true } };
  };
  t.extras.fire(order('y'));
  await settle();
  assert.deepEqual(t.ran, ['y', 'x']);
  t.orders.stop();
});

test('only strings are reported back', async () => {
  const t = setup({ pending: [order('a')], execute: async () => ({ ok: false, error: { no: 1 }, caption: 7 }) });
  t.orders.start();
  await settle();
  assert.deepEqual(t.done, [{ id: 'a', ok: false }]);
  t.orders.stop();
});

test('a throwing onDone does not stop the orders after it', async () => {
  const t = setup({ pending: [order('a'), order('b')], onDone: () => { throw new Error('ui'); } });
  t.orders.start();
  await settle();
  assert.deepEqual(t.ran, ['a', 'b']);
  t.orders.stop();
});

test('start is idempotent, and nothing runs after stop', async () => {
  const t = setup({ pending: [] });
  t.orders.start();
  t.orders.start();
  await settle();
  assert.equal(t.extras.streams, 1);
  assert.equal(t.calls.filter((c) => c.method === 'GET').length, 1);
  t.orders.stop();
  t.orders.stop();
  t.extras.fire(order('late'));
  await settle();
  assert.deepEqual(t.ran, []);
  t.orders.start();
  await settle();
  assert.equal(t.extras.streams, 2);
  t.orders.stop();
});

test('a stream that ended by itself (a 401) is opened again by the next start, and the pending orders are fetched again', async () => {
  const t = setup({ pending: [], endAtOnce: true });
  t.orders.start();
  await settle();
  assert.deepEqual(t.orders.state(), { running: true, listening: false, current: null });
  t.orders.start();
  await settle();
  assert.equal(t.extras.streams, 2);
  assert.equal(t.calls.filter((c) => c.method === 'GET').length, 2);
  t.orders.stop();
});

test('a hub that is down at the start is asked for the pending orders again after 30 seconds', async () => {
  const t = setup({ pending: [order('a')], answers: [{ ok: false, status: 0, body: { error: 'Hub unreachable.' } }] });
  t.orders.start();
  await settle();
  assert.deepEqual(t.ran, []);
  assert.equal(t.timeouts.length, 1);
  assert.equal(t.timeouts[0].ms, 30_000);
  t.timeouts[0].fn();
  await settle();
  assert.deepEqual(t.ran, ['a']);
  assert.equal(t.timeouts.length, 1);
  t.orders.stop();
});

test('every time the stream (re)connects the pending orders are fetched again, and an order is run once', async () => {
  const pending = [];
  const t = setup({ pending });
  t.orders.start();
  await settle();
  t.extras.open();
  await settle();
  assert.deepEqual(t.ran, []);
  pending.push(order('z'));   // placed while the stream was down: no event will ever announce it
  t.extras.open();
  await settle();
  assert.deepEqual(t.ran, ['z']);
  t.extras.open();
  await settle();
  assert.deepEqual(t.ran, ['z']);
  assert.equal(t.done.length, 1);
  t.orders.stop();
});

test('a result the hub did not take is sent again later, and the order is not run again', async () => {
  const t = setup({ pending: [order('a')], doneAnswers: [{ ok: false, status: 0, body: { error: 'Hub unreachable.' } }] });
  t.orders.start();
  await settle();
  assert.deepEqual(t.ran, ['a']);
  assert.deepEqual(t.done, []);
  assert.deepEqual(t.dones.map(([id]) => id), ['a']);
  assert.equal(t.timeouts.length, 1);
  assert.equal(t.timeouts[0].ms, 30_000);
  t.timeouts[0].fn();   // the hub still lists it as pending
  await settle();
  assert.deepEqual(t.ran, ['a']);
  assert.deepEqual(t.done, [{ id: 'a', ok: true, caption: 'did a' }]);
  assert.equal(t.dones.length, 1);
  assert.equal(t.timeouts.length, 1);
  t.orders.stop();
});

test('a result is sent again at the next drain, and keeps being tried every 30 seconds while the hub is down', async () => {
  const down = { ok: false, status: 503, body: {} };
  const t = setup({ pending: [order('a')], doneAnswers: [down, down] });
  t.orders.start();
  await settle();
  t.timeouts[0].fn();
  await settle();
  assert.deepEqual(t.done, []);
  assert.equal(t.timeouts.length, 2);
  t.extras.open();   // a reconnect drains too
  await settle();
  assert.deepEqual(t.done.map((d) => d.id), ['a']);
  assert.deepEqual(t.ran, ['a']);
  t.orders.stop();
});

test('a result the hub refuses for good (it no longer knows the order) is dropped, not retried', async () => {
  const t = setup({ pending: [order('a')], doneAnswers: [{ ok: false, status: 404, body: { error: 'No such order.' } }] });
  t.orders.start();
  await settle();
  assert.equal(t.timeouts.length, 0);
  t.extras.open();
  await settle();
  assert.deepEqual(t.ran, ['a']);
  assert.equal(t.calls.filter((c) => c.path.endsWith('/done')).length, 1);
  t.orders.stop();
});

test('an order that arrives once the Mac is signed out, or signed in as someone else, is not run', async () => {
  const t = setup();
  t.orders.start();
  await settle();
  t.extras.who = { loggedIn: false, account: null };
  t.extras.fire(order('a'));
  await settle();
  t.extras.who = { loggedIn: true, account: { id: 'b2' } };
  t.extras.fire(order('b'));
  await settle();
  assert.deepEqual(t.ran, []);
  t.orders.stop();
});

test('a stream that ended at a sign-out hears nothing more, and the next start opens a new one for the account signed in now', async () => {
  const t = setup({ pending: [] });
  t.orders.start();
  await settle();
  t.extras.who = { loggedIn: false, account: null };
  const fire = t.extras.fire;
  t.extras.end();
  await settle();
  assert.equal(t.orders.state().listening, false);
  t.extras.who = { loggedIn: true, account: { id: 'a1' } };
  fire(order('late'));   // delivered by the stream that already ended
  await settle();
  assert.deepEqual(t.ran, []);
  t.extras.who = { loggedIn: true, account: { id: 'b2' } };
  t.orders.start();
  await settle();
  assert.equal(t.extras.streams, 2);
  t.extras.fire(order('b'));
  await settle();
  assert.deepEqual(t.ran, ['b']);
  t.orders.stop();
});

test('an order is claimed with this Mac\'s device before it runs', async () => {
  const t = setup({ pending: [order('a')] });
  t.hub.status = () => ({ ...t.extras.who, device: 'mac-1' });
  t.orders.start();
  await settle();
  const posts = t.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]);
  assert.deepEqual(posts[0], ['/api/me/orders/a/claim', { device: 'mac-1' }]);
  assert.equal(posts[1][0], '/api/me/orders/a/done');
  assert.deepEqual(t.ran, ['a']);
  t.orders.stop();
});

test('an order another Mac claimed first (409) or the hub no longer has (404) is left alone, silently', async () => {
  const t = setup({ pending: [order('a'), order('b')], claimAnswers: [{ ok: false, status: 409, body: { ok: false } }, { ok: false, status: 404, body: { ok: false } }] });
  t.orders.start();
  await settle();
  assert.deepEqual(t.ran, []);
  assert.deepEqual(t.done, []);
  assert.equal(t.timeouts.length, 0);
  t.orders.stop();
});

test('a claim the hub could not answer runs nothing, and is asked again after 30 seconds', async () => {
  const t = setup({ pending: [order('a')], claimAnswers: [{ ok: false, status: 0, body: { error: 'Hub unreachable.' } }, { ok: false, status: 502, body: {} }] });
  t.orders.start();
  await settle();
  assert.deepEqual(t.ran, []);
  assert.equal(t.timeouts.length, 1);
  assert.equal(t.timeouts[0].ms, 30_000);
  t.timeouts[0].fn();
  await settle();
  assert.deepEqual(t.ran, []);
  assert.equal(t.timeouts.length, 2);
  t.timeouts[1].fn();
  await settle();
  assert.deepEqual(t.ran, ['a']);
  t.orders.stop();
});

test('two Macs signed in to one account: each order is run by exactly one of them', async () => {
  const db = openDb(':memory:');
  const accountId = createAccounts(db).signIn({ provider: 'dev', subject: 'alice', login: 'alice' }).account.id;
  const queue = createOrders(db);
  /** What the hub's routes do for these calls, straight on its orders module. */
  const hubFor = (device) => async (method, path, { body } = {}) => {
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    if (method === 'GET') return { ok: true, status: 200, body: { ok: true, orders: queue.pending(accountId) } };
    const r = path.endsWith('/claim') ? queue.claim(accountId, id, body.device ?? device) : queue.done(accountId, id, body);
    return { ok: r.ok, status: r.ok ? 200 : r.status, body: r };
  };
  const placed = [];
  for (let i = 0; i < 3; i++) {
    const r = queue.place(accountId, { kind: 'frontier', ang: i });
    placed.push(r.order);
    if (i < 2) queue.done(accountId, r.order.id, { ok: true });   // only one is out at a time; these two landed already
  }
  const ran = [];
  const macs = ['one', 'two'].map((name) => {
    const t = setup({ request: hubFor(name), execute: async (o) => { ran.push([name, o.id]); return { ok: true }; } });
    t.hub.status = () => ({ loggedIn: true, account: { id: 'a1' }, device: name });
    return t;
  });
  for (const m of macs) m.orders.start();
  for (const m of macs) m.extras.fire(placed[2]);
  await settle();
  assert.equal(ran.length, 1, JSON.stringify(ran));
  assert.equal(ran[0][1], placed[2].id);
  assert.equal(queue.list(accountId)[0].status, 'done');
  for (const m of macs) m.orders.stop();
});

test('drain asks the hub for its pending orders while the stream is up, so an order no event announced still runs', async () => {
  const pending = [];
  const t = setup({ pending });
  t.orders.drain();   // not started: nothing to ask
  await settle();
  assert.equal(t.calls.length, 0);
  t.orders.start();
  await settle();
  pending.push(order('quiet'));   // placed, but the event never arrived
  t.orders.drain();
  await settle();
  assert.deepEqual(t.ran, ['quiet']);
  t.orders.drain();
  await settle();
  assert.deepEqual(t.ran, ['quiet'], 'and it is not run twice');
  t.orders.stop();
  const asked = t.calls.filter((c) => c.method === 'GET').length;
  t.orders.drain();
  await settle();
  assert.equal(t.calls.filter((c) => c.method === 'GET').length, asked, 'nothing is asked after stop');
});

test('onOpen is told of every (re)connect, and one that throws or rejects breaks nothing', async () => {
  let opened = 0;
  const t = setup({ onOpen: () => { opened++; if (opened === 1) throw new Error('sync'); return Promise.reject(new Error('async')); } });
  t.orders.start();
  await settle();
  t.extras.open();
  t.extras.open();
  await settle();
  assert.equal(opened, 2);
  t.extras.fire(order('a'));
  await settle();
  assert.deepEqual(t.ran, ['a']);
  t.orders.stop();
});

test('an order claimed by a Mac that went away is released an hour after the claim, not before', () => {
  const db = openDb(':memory:');
  let clock = Date.UTC(2026, 9, 22, 12, 0);
  const accountId = createAccounts(db, { now: () => clock }).signIn({ provider: 'dev', subject: 'alice', login: 'alice' }).account.id;
  const queue = createOrders(db, { now: () => clock });
  assert.equal(RUNNING_TTL_MS, 3_600_000);
  const { order } = queue.place(accountId, { kind: 'frontier', ang: 0 });
  assert.equal(queue.claim(accountId, order.id, 'mac-one').ok, true);
  const claimedAt = clock;
  clock = claimedAt + 59 * 60_000;
  assert.deepEqual(queue.pending(accountId), []);
  assert.equal(queue.list(accountId)[0].status, 'running');
  assert.equal(queue.place(accountId, { kind: 'frontier', ang: 1 }).status, 409, 'still out after 59 minutes');
  clock = claimedAt + 61 * 60_000;
  assert.deepEqual(queue.pending(accountId), []);
  assert.equal(queue.list(accountId)[0].status, 'expired');
  assert.equal(queue.done(accountId, order.id, { ok: true }).status, 404, 'a late report finds nothing, as after the day-long expiry');
  assert.equal(queue.place(accountId, { kind: 'frontier', ang: 1 }).ok, true);
});
