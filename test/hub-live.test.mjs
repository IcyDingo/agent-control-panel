// The per-account event stream: what the Mac's service holds open to hear about an order at once. A fake response records
// every write, and fake timers let the test fire the keep-alive ping without waiting 20 seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLive } from '../hub/live.mjs';

function fakeRes() {
  const res = { head: null, writes: [], ended: false, listeners: {}, throwOnWrite: false };
  res.writeHead = (status, headers) => { res.head = { status, headers }; };
  res.write = (chunk) => { if (res.throwOnWrite) throw new Error('socket gone'); res.writes.push(chunk); return true; };
  res.end = () => { res.ended = true; };
  res.on = (name, fn) => { res.listeners[name] = fn; return res; };
  return res;
}

function fakeTimers() {
  const t = { intervals: new Map() };
  t.setInterval = (fn, ms) => { const id = { ms, unrefd: false, unref() { id.unrefd = true; } }; t.intervals.set(id, fn); return id; };
  t.clearInterval = (id) => { t.intervals.delete(id); };
  t.tick = () => { for (const fn of [...t.intervals.values()]) fn(); };
  return t;
}

const setup = () => { const timers = fakeTimers(); return { timers, live: createLive({ timers }) }; };
const ORDER_EVENT = 'event: order\ndata: {"id":"o1"}\n\n';

test('subscribing writes the event-stream headers and a retry hint', () => {
  const { live } = setup();
  const res = fakeRes();
  live.subscribe('a1', res);
  assert.equal(res.head.status, 200);
  assert.equal(res.head.headers['content-type'], 'text/event-stream');
  assert.equal(res.head.headers['cache-control'], 'no-store');
  assert.equal(res.head.headers.connection, 'keep-alive');
  assert.equal(res.head.headers['x-accel-buffering'], 'no');
  assert.deepEqual(res.writes, ['retry: 2000\n\n']);
});

test('an emitted event is written as one event and data line to every subscriber of that account', () => {
  const { live } = setup();
  const a = fakeRes(), b = fakeRes(), other = fakeRes();
  live.subscribe('a1', a); live.subscribe('a1', b); live.subscribe('a2', other);
  live.emit('a1', 'order', { id: 'o1' });
  assert.equal(a.writes.at(-1), ORDER_EVENT);
  assert.equal(b.writes.at(-1), ORDER_EVENT);
  assert.deepEqual(other.writes, ['retry: 2000\n\n']);
});

test('emitting to an account with no subscribers does nothing', () => {
  const { live } = setup();
  assert.doesNotThrow(() => live.emit('nobody', 'order', { id: 'o1' }));
  assert.equal(live.count('nobody'), 0);
});

test('a ping comment goes out every 20 seconds and the timer never keeps the process alive', () => {
  const { live, timers } = setup();
  const res = fakeRes();
  live.subscribe('a1', res);
  const [timer] = timers.intervals.keys();
  assert.equal(timer.ms, 20_000);
  assert.equal(timer.unrefd, true);
  timers.tick();
  assert.equal(res.writes.at(-1), ': ping\n\n');
});

test('unsubscribing stops further writes and clears the ping, and can be done twice', () => {
  const { live, timers } = setup();
  const res = fakeRes();
  const unsubscribe = live.subscribe('a1', res);
  assert.equal(live.count('a1'), 1);
  unsubscribe();
  unsubscribe();
  const before = res.writes.length;
  live.emit('a1', 'order', { id: 'o1' });
  timers.tick();
  assert.equal(res.writes.length, before);
  assert.equal(live.count('a1'), 0);
  assert.equal(timers.intervals.size, 0);
});

test('a closed connection unsubscribes itself', () => {
  const { live, timers } = setup();
  const res = fakeRes();
  live.subscribe('a1', res);
  res.listeners.close();
  assert.equal(live.count('a1'), 0);
  assert.equal(timers.intervals.size, 0);
});

test('a sixth stream closes the oldest and the count stays at five', () => {
  const { live } = setup();
  const streams = Array.from({ length: 6 }, () => fakeRes());
  streams.slice(0, 5).forEach((r) => live.subscribe('a1', r));
  assert.equal(live.count('a1'), 5);
  live.subscribe('a1', streams[5]);
  assert.equal(streams[0].ended, true);
  assert.equal(streams[1].ended, false);
  assert.equal(live.count('a1'), 5);
  live.emit('a1', 'order', { id: 'o1' });
  assert.equal(streams[0].writes.length, 1);
  assert.equal(streams[5].writes.at(-1), ORDER_EVENT);
});

test('a stream whose socket is gone is dropped when a write throws', () => {
  const { live, timers } = setup();
  const dead = fakeRes(), alive = fakeRes();
  live.subscribe('a1', dead); live.subscribe('a1', alive);
  dead.throwOnWrite = true;
  live.emit('a1', 'order', { id: 'o1' });
  assert.equal(live.count('a1'), 1);
  assert.equal(alive.writes.at(-1), ORDER_EVENT);
  assert.equal(timers.intervals.size, 1);
});

test('closing by token or by session ends only the streams that credential opened, and no later emit reaches them', () => {
  const { live, timers } = setup();
  const mac = fakeRes(), otherMac = fakeRes(), tab = fakeRes(), otherTab = fakeRes();
  live.subscribe('a1', mac, { tokenId: 't1' });
  live.subscribe('a1', otherMac, { tokenId: 't2' });
  live.subscribe('a1', tab, { sessionId: 's1' });
  live.subscribe('a1', otherTab, { sessionId: 's2' });
  assert.equal(live.closeByToken('t1'), 1);
  assert.equal(live.closeBySession('s1'), 1);
  assert.deepEqual([mac.ended, otherMac.ended, tab.ended, otherTab.ended], [true, false, true, false]);
  assert.equal(live.count('a1'), 2);
  assert.equal(timers.intervals.size, 2);
  live.emit('a1', 'order', { id: 'o1' });
  assert.deepEqual(mac.writes, ['retry: 2000\n\n']);
  assert.deepEqual(tab.writes, ['retry: 2000\n\n']);
  assert.equal(otherMac.writes.at(-1), ORDER_EVENT);
  assert.equal(live.closeByToken('nobody'), 0);
  assert.equal(live.closeByToken(null), 0, 'a missing token id matches nothing');
});
