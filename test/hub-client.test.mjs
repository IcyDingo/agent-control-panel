// The Mac's client for the hub: the credentials file, authenticated requests, the device sign-in and the event stream.
// A fake `fetch` records every call and answers from a script; the file lives in a temp folder; the clock is a variable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_HUB, parseSse, createHub } from '../hub.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** A fake fetch: `answer(call, n)` returns the Response (or a promise of one); every call is recorded. */
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, signal: init.signal };
    calls.push(call);
    return answer(call, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function setup(answer = () => json({ ok: true }), extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-'));
  const file = path.join(dir, 'sub', 'hub.json');
  const clock = { t: 1_000_000 };
  const fetch = fakeFetch(answer);
  const logs = [];
  const hub = createHub({ file, hubUrl: 'http://hub.test/', fetch, now: () => clock.t, log: (m) => logs.push(m), ...extra });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const bump = (secs = 10) => { const t = new Date(fs.statSync(file).mtimeMs + secs * 1000); fs.utimesSync(file, t, t); };
  return { dir, file, clock, fetch, hub, logs, read, bump };
}

const ACCOUNT = { id: 'a1', handle: 'ada', x: 3, y: -4, name: 'Ada', avatar: null };
const CODE = { ok: true, device_code: 'dc-secret', user_code: 'ABCD-EFGH', verification_uri: 'http://hub.test/device', verification_uri_complete: 'http://hub.test/device?code=ABCD-EFGH', expires_in: 900, interval: 5 };

function signedIn(s, token = 'hub_secret') {
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, JSON.stringify({ v: 1, url: 'http://hub.test', device: 'dev-1', token, account: ACCOUNT }));
}

test('the default hub is the Universe, over https, with no trailing slash', () => {
  assert.equal(DEFAULT_HUB, 'https://universe.cashegg.com');
});

test('parseSse splits events, defaults the name to message and parses JSON data', () => {
  const { events, rest } = parseSse('event: order\ndata: {"id":"o1"}\n\ndata: plain\n\n');
  assert.deepEqual(events, [{ event: 'order', data: { id: 'o1' } }, { event: 'message', data: 'plain' }]);
  assert.equal(rest, '');
});

test('parseSse joins multi-line data, ignores comments and tolerates CRLF', () => {
  const { events } = parseSse(': ping\n\nevent: x\r\ndata: one\r\ndata: two\r\n\r\n');
  assert.deepEqual(events, [{ event: 'x', data: 'one\ntwo' }]);
});

test('parseSse hands back a partial block so the next chunk can finish it', () => {
  const first = parseSse('event: a\ndata: {"n":1}\n\nevent: b\nda');
  assert.equal(first.events.length, 1);
  assert.equal(first.rest, 'event: b\nda');
  const second = parseSse(first.rest + 'ta: {"n":2}\n\n');
  assert.deepEqual(second.events, [{ event: 'b', data: { n: 2 } }]);
  assert.equal(second.rest, '');
});

test('a missing file means signed out, with a device id that stays the same', () => {
  const s = setup();
  const st = s.hub.status();
  assert.equal(st.url, 'http://hub.test');
  assert.equal(st.loggedIn, false);
  assert.equal(st.account, null);
  assert.equal(st.pending, null);
  assert.match(st.device, /^[0-9a-f-]{36}$/);
  assert.equal(s.hub.status().device, st.device);
  assert.equal(s.hub.lastSync(), null);
});

test('a file that does not parse counts as absent and is logged once, never thrown', () => {
  const s = setup();
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, '{ nope');
  assert.equal(s.hub.status().loggedIn, false);
  assert.equal(s.hub.status().loggedIn, false);
  assert.equal(s.logs.length, 1);
});

test('request sends the bearer and a JSON body, and returns the parsed answer', async () => {
  const s = setup(() => json({ ok: true, seq: 4 }));
  signedIn(s);
  const r = await s.hub.request('PUT', '/api/me/system', { body: { a: 1 } });
  assert.deepEqual(r, { ok: true, status: 200, body: { ok: true, seq: 4 } });
  const c = s.fetch.calls[0];
  assert.equal(c.url, 'http://hub.test/api/me/system');
  assert.equal(c.method, 'PUT');
  assert.equal(c.headers.authorization, 'Bearer hub_secret');
  assert.equal(c.headers['content-type'], 'application/json');
  assert.equal(c.body, '{"a":1}');
});

test('request returns an empty body for an empty answer and passes error statuses through', async () => {
  const s = setup((c, n) => (n === 1 ? new Response(null, { status: 204 }) : json({ ok: false, error: 'Nope.' }, 404)));
  signedIn(s);
  assert.deepEqual(await s.hub.request('DELETE', '/x'), { ok: true, status: 204, body: {} });
  assert.deepEqual(await s.hub.request('GET', '/y'), { ok: false, status: 404, body: { ok: false, error: 'Nope.' } });
});

test('request does not throw when the hub is unreachable or too slow', async () => {
  const down = setup(() => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await down.hub.request('GET', '/x'), { ok: false, status: 0, body: { error: 'Hub unreachable.' } });
  // A real socket keeps the process alive while it waits; the fake holds a timer for the same reason.
  const slow = setup((c) => new Promise((_, reject) => {
    const hold = setTimeout(() => {}, 5000);
    c.signal.addEventListener('abort', () => { clearTimeout(hold); reject(c.signal.reason); });
  }));
  assert.deepEqual(await slow.hub.request('GET', '/x', { timeout: 20 }), { ok: false, status: 0, body: { error: 'Hub unreachable.' } });
});

test('a 401 signs out until the file is written again', async () => {
  const s = setup(() => json({ ok: false, error: 'Sign in first.' }, 401));
  signedIn(s);
  assert.equal(s.hub.status().loggedIn, true);
  assert.equal((await s.hub.request('GET', '/api/me')).status, 401);
  assert.equal(s.hub.status().loggedIn, false);
  assert.equal(s.hub.status().account, null);
  signedIn(s, 'hub_fresh');
  s.bump();
  assert.equal(s.hub.status().loggedIn, true);
  await s.hub.request('GET', '/api/me');
  assert.equal(s.fetch.calls.at(-1).headers.authorization, 'Bearer hub_fresh');
});

test('a login made in a terminal is picked up by the running client when the file changes', () => {
  const s = setup();
  assert.equal(s.hub.status().loggedIn, false);
  signedIn(s);
  s.bump();
  const st = s.hub.status();
  assert.equal(st.loggedIn, true);
  assert.equal(st.account.handle, 'ada');
  assert.equal(st.device, 'dev-1');
});

test('starting a device login saves the pending code in the file', async () => {
  const s = setup(() => json(CODE));
  const r = await s.hub.startDeviceLogin();
  assert.deepEqual(r, { ok: true, userCode: 'ABCD-EFGH', verificationUri: CODE.verification_uri_complete, expiresAt: 1_000_000 + 900_000, interval: 5 });
  assert.equal(s.fetch.calls[0].url, 'http://hub.test/api/device/code');
  assert.equal(s.fetch.calls[0].method, 'POST');
  assert.equal(s.read().pending.deviceCode, 'dc-secret');
  const st = s.hub.status();
  assert.deepEqual(st.pending, { userCode: 'ABCD-EFGH', verificationUri: CODE.verification_uri_complete, expiresAt: 1_900_000, interval: 5 });
  assert.ok(!JSON.stringify(st).includes('dc-secret'));
});

test('a device login that the hub refuses says why and saves nothing', async () => {
  const s = setup(() => json({ ok: false, error: 'Busy.' }, 503));
  assert.deepEqual(await s.hub.startDeviceLogin(), { ok: false, error: 'Busy.' });
  assert.equal(fs.existsSync(s.file), false);
  const down = setup(() => { throw new Error('boom'); });
  assert.deepEqual(await down.hub.startDeviceLogin(), { ok: false, error: 'Hub unreachable.' });
});

test('slow_down lengthens the poll interval by 5 s each time, in the file and in status', async () => {
  const s = setup((c) => (c.url.endsWith('/device/code') ? json(CODE) : json({ ok: false, error: 'slow_down' }, 429)));
  await s.hub.startDeviceLogin();
  assert.equal(await s.hub.pollDeviceLogin(), 'pending');
  assert.equal(s.hub.status().pending.interval, 10);
  assert.equal(await s.hub.pollDeviceLogin(), 'pending');
  assert.equal(s.hub.status().pending.interval, 15);
  assert.equal(s.read().pending.interval, 15);
  assert.equal(s.read().pending.deviceCode, 'dc-secret');
});

test('a null body from the hub is an error, not a crash', async () => {
  const s = setup(() => new Response('null', { status: 200 }));
  const r = await s.hub.startDeviceLogin();
  assert.equal(r.ok, false);
  assert.deepEqual((await s.hub.request('GET', '/x')).body, {});
  const p = setup((c) => (c.url.endsWith('/device/code') ? json(CODE) : new Response('null', { status: 200 })));
  await p.hub.startDeviceLogin();
  assert.equal(await p.hub.pollDeviceLogin(), 'error');
});

test('a file that cannot be written is a return value, never a throw', async () => {
  const s = setup(() => json(CODE));
  fs.writeFileSync(path.join(s.dir, 'sub'), 'a file where the folder should be');
  assert.deepEqual(await s.hub.startDeviceLogin(), { ok: false, error: 'Could not write the hub file.' });
  assert.equal(s.hub.saveSync({ seq: 1, hash: 'h', at: 1 }), false);
  assert.equal(s.logs.length, 2);
  assert.ok(s.logs.every((l) => !l.includes('dc-secret')));
});

test('a folder that turns read-only fails sign-in polling, cancelling and syncing without throwing', async () => {
  const s = setup((c) => (c.url.endsWith('/device/code') ? json(CODE) : json({ ok: true, token: 'hub_new', account: ACCOUNT })));
  await s.hub.startDeviceLogin();
  const folder = path.dirname(s.file);
  fs.chmodSync(folder, 0o500);
  try {
    assert.equal(await s.hub.pollDeviceLogin(), 'error');
    assert.equal(s.hub.status().loggedIn, false);
    assert.equal(s.hub.cancelDeviceLogin(), false);
    assert.equal(s.hub.saveSync({ seq: 1, hash: 'h', at: 1 }), false);
    assert.equal(fs.readdirSync(folder).join(), 'hub.json');
    assert.ok(s.logs.every((l) => !l.includes('hub_new')));
  } finally { fs.chmodSync(folder, 0o700); }
});

test('every write uses a tmp file of its own and leaves none behind', () => {
  const s = setup();
  const seenTmp = new Set();
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { seenTmp.add(from); return realRename(from, to); };
  try {
    s.hub.saveSync({ seq: 1, hash: 'a', at: 1 });
    s.hub.saveSync({ seq: 2, hash: 'b', at: 2 });
  } finally { fs.renameSync = realRename; }
  assert.equal(seenTmp.size, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(s.file)), ['hub.json']);
});

test('a token issued by another hub is never sent to this one', async () => {
  const s = setup();
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, JSON.stringify({ v: 1, url: 'http://other.example', device: 'dev-1', token: 'hub_other', account: ACCOUNT }));
  const st = s.hub.status();
  assert.equal(st.loggedIn, false);
  assert.equal(st.account, null);
  await s.hub.request('GET', '/api/me');
  assert.equal(s.fetch.calls[0].headers.authorization, undefined);
  s.hub.saveSync({ seq: 1, hash: 'h', at: 1 });
  assert.equal(s.read().url, 'http://other.example');   // a sync does not re-bind the token to this hub
  assert.equal(s.hub.status().loggedIn, false);
});

test('signing in again replaces a login made for another hub', async () => {
  const s = setup((c) => (c.url.endsWith('/device/code') ? json(CODE) : json({ ok: true, token: 'hub_new', account: ACCOUNT })));
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, JSON.stringify({ v: 1, url: 'http://other.example', device: 'dev-1', token: 'hub_other', account: ACCOUNT, lastSync: { seq: 9, hash: 'x', at: 1 } }));
  await s.hub.startDeviceLogin();
  assert.equal(await s.hub.pollDeviceLogin(), 'ok');
  assert.equal(s.read().url, 'http://hub.test');
  assert.equal(s.read().token, 'hub_new');
  assert.equal(s.hub.lastSync(), null);
  assert.equal(s.hub.status().loggedIn, true);
});

test('polling 428, 428, 200 ends signed in with the token only in a private file', async () => {
  const answers = [json({ ok: false, error: 'authorization_pending' }, 428), json({ ok: false, error: 'authorization_pending' }, 428), json({ ok: true, token: 'hub_new', account: ACCOUNT })];
  const s = setup((c) => (c.url.endsWith('/device/code') ? json(CODE) : answers.shift()));
  await s.hub.startDeviceLogin();
  assert.equal(await s.hub.pollDeviceLogin(), 'pending');
  assert.equal(await s.hub.pollDeviceLogin(), 'pending');
  assert.equal(s.hub.status().loggedIn, false);
  assert.equal(await s.hub.pollDeviceLogin(), 'ok');
  assert.deepEqual(JSON.parse(s.fetch.calls[1].body), { device_code: 'dc-secret' });
  assert.equal(s.read().token, 'hub_new');
  assert.equal(s.read().pending, null);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  const st = s.hub.status();
  assert.equal(st.loggedIn, true);
  assert.deepEqual(st.account, ACCOUNT);
  assert.equal(st.pending, null);
  assert.ok(!JSON.stringify(st).includes('hub_new'));
});

test('polling maps slow_down to pending and expired or denied to a cleared login', async () => {
  const run = async (status, error) => {
    const s = setup((c) => (c.url.endsWith('/device/code') ? json(CODE) : json({ ok: false, error }, status)));
    await s.hub.startDeviceLogin();
    const result = await s.hub.pollDeviceLogin();
    return { result, pending: s.hub.status().pending };
  };
  const slow = await run(429, 'slow_down');
  assert.equal(slow.result, 'pending');
  assert.notEqual(slow.pending, null);
  assert.deepEqual(await run(410, 'expired'), { result: 'expired', pending: null });
  assert.deepEqual(await run(403, 'denied'), { result: 'denied', pending: null });
});

test('polling reports an error but keeps the pending code until it has expired', async () => {
  const s = setup((c) => (c.url.endsWith('/device/code') ? json(CODE) : json({ ok: false, error: 'oops' }, 500)));
  assert.equal(await s.hub.pollDeviceLogin(), 'error');
  await s.hub.startDeviceLogin();
  assert.equal(await s.hub.pollDeviceLogin(), 'error');
  assert.notEqual(s.hub.status().pending, null);
  s.clock.t += 901_000;
  assert.equal(await s.hub.pollDeviceLogin(), 'error');
  assert.equal(s.hub.status().pending, null);
});

test('a restarted client continues a pending login from the file', async () => {
  const s = setup((c) => (c.url.endsWith('/device/code') ? json(CODE) : json({ ok: true, token: 'hub_t', account: ACCOUNT })));
  await s.hub.startDeviceLogin();
  const again = createHub({ file: s.file, hubUrl: 'http://hub.test', fetch: s.fetch, now: () => s.clock.t });
  assert.equal(again.status().pending.userCode, 'ABCD-EFGH');
  assert.equal(await again.pollDeviceLogin(), 'ok');
  assert.equal(again.status().loggedIn, true);
});

test('cancelling a device login clears the pending code', async () => {
  const s = setup(() => json(CODE));
  await s.hub.startDeviceLogin();
  s.hub.cancelDeviceLogin();
  assert.equal(s.hub.status().pending, null);
  assert.equal(await s.hub.pollDeviceLogin(), 'error');
});

test('saving a sync keeps it in the file next to the credentials', () => {
  const s = setup();
  signedIn(s);
  assert.equal(s.hub.lastSync(), null);
  s.hub.saveSync({ seq: 7, hash: 'abc', at: 123 });
  assert.deepEqual(s.hub.lastSync(), { seq: 7, hash: 'abc', at: 123 });
  assert.deepEqual(s.read().lastSync, { seq: 7, hash: 'abc', at: 123 });
  assert.equal(s.read().token, 'hub_secret');
  assert.equal(s.hub.status().loggedIn, true);
});

test('writing the file keeps it private even when it already existed with looser rights', () => {
  const s = setup();
  signedIn(s);
  fs.chmodSync(s.file, 0o644);
  s.hub.saveSync({ seq: 1, hash: 'h', at: 1 });
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(s.file)), ['hub.json']);
});

test('logging out revokes the token on the hub and deletes the file', async () => {
  const s = setup(() => json({ ok: true }));
  signedIn(s);
  const device = s.hub.status().device;
  await s.hub.logout();
  const c = s.fetch.calls[0];
  assert.equal(c.method, 'DELETE');
  assert.equal(c.url, 'http://hub.test/api/me/tokens/self');
  assert.equal(c.headers.authorization, 'Bearer hub_secret');
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(s.hub.status().loggedIn, false);
  assert.equal(s.hub.status().device, device);
});

test('logging out reports a file it cannot remove instead of throwing', async () => {
  const s = setup();
  fs.mkdirSync(s.file, { recursive: true });   // a folder where the file should be: rmSync refuses
  assert.deepEqual(await s.hub.logout(), { ok: false, error: 'Could not remove the hub file.' });
});

test('logging out still deletes the file when the hub cannot be reached, and asks nothing when signed out', async () => {
  const s = setup(() => { throw new Error('offline'); });
  signedIn(s);
  await s.hub.logout();
  assert.equal(fs.existsSync(s.file), false);
  const none = setup();
  await none.hub.logout();
  assert.equal(none.fetch.calls.length, 0);
});

/** A streaming response whose chunks the test pushes; it errors the way a real one does when the signal aborts. */
function streamResponse(signal) {
  let ctl;
  const body = new ReadableStream({ start(c) { ctl = c; } });
  signal?.addEventListener('abort', () => { try { ctl.error(signal.reason); } catch { /* already closed */ } });
  const enc = new TextEncoder();
  return { res: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }), push: (t) => ctl.enqueue(enc.encode(t)), end: () => ctl.close() };
}

const until = async (cond) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'timed out waiting');
};

test('stream delivers events across chunk boundaries and resolves when aborted', async () => {
  let live;
  const s = setup((c) => { live = streamResponse(c.signal); return live.res; });
  signedIn(s);
  const got = [];
  const ac = new AbortController();
  const done = s.hub.stream('/api/me/events', (event, data) => got.push([event, data]), { signal: ac.signal });
  await until(() => live);
  live.push('retry: 2000\n\n: ping\n\nevent: order\ndata: {"id"');
  live.push(':"o1"}\n\nevent: system\ndata: {"seq":2}\n\n');
  await until(() => got.length === 2);
  assert.deepEqual(got, [['order', { id: 'o1' }], ['system', { seq: 2 }]]);
  const c = s.fetch.calls[0];
  assert.equal(c.url, 'http://hub.test/api/me/events');
  assert.equal(c.headers.authorization, 'Bearer hub_secret');
  assert.equal(c.headers.accept, 'text/event-stream');
  ac.abort();
  await done;
  assert.equal(s.fetch.calls.length, 1);
});

test('stream reconnects with a growing wait after failures and the hub closing it, starting over once data flows', async () => {
  const waits = [];
  const ac = new AbortController();
  const lives = [];
  const s = setup((c, n) => {
    if (n === 1 || n === 2) return json({ ok: false }, 502);
    const l = streamResponse(c.signal);
    lives.push(l);
    return l.res;
  }, { sleep: async (ms) => { waits.push(ms); } });
  signedIn(s);
  const got = [];
  const done = s.hub.stream('/api/me/events', (e, d) => got.push(d), { signal: ac.signal });
  await until(() => lives.length === 1);
  lives[0].push('data: 1\n\n');
  await until(() => got.length === 1);
  lives[0].end();
  await until(() => lives.length === 2);
  assert.deepEqual(waits, [2000, 4000, 2000]);
  ac.abort();
  await done;
});

test('stream waits no longer than a minute between attempts', async () => {
  const waits = [];
  const ac = new AbortController();
  const s = setup(() => json({ ok: false }, 500), { sleep: async (ms) => { waits.push(ms); if (waits.length === 8) ac.abort(); } });
  signedIn(s);
  await s.hub.stream('/x', () => {}, { signal: ac.signal });
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test('a 401 on the stream signs out and ends it', async () => {
  const s = setup(() => json({ ok: false, error: 'Sign in first.' }, 401));
  signedIn(s);
  await s.hub.stream('/api/me/events', () => {}, { signal: new AbortController().signal });
  assert.equal(s.fetch.calls.length, 1);
  assert.equal(s.hub.status().loggedIn, false);
});

test('a handler that throws does not break the stream', async () => {
  let live;
  const s = setup((c) => { live = streamResponse(c.signal); return live.res; });
  signedIn(s);
  const got = [];
  const ac = new AbortController();
  const done = s.hub.stream('/x', (e, d) => { got.push(d); if (d === 1) throw new Error('bad handler'); }, { signal: ac.signal });
  await until(() => live);
  live.push('data: 1\n\ndata: 2\n\n');
  await until(() => got.length === 2);
  ac.abort();
  await done;
});

test('stream tells onOpen once per successful connect, not for a failed one, and a throwing onOpen does not break it', async () => {
  const ac = new AbortController();
  const lives = [];
  const s = setup((c, n) => {
    if (n === 1) return json({ ok: false }, 502);
    const l = streamResponse(c.signal);
    lives.push(l);
    return l.res;
  }, { sleep: async () => {} });
  signedIn(s);
  const got = [];
  let opened = 0;
  const done = s.hub.stream('/api/me/events', (e, d) => got.push(d), { signal: ac.signal, onOpen: () => { opened++; throw new Error('bad hook'); } });
  await until(() => lives.length === 1);
  assert.equal(opened, 1);
  lives[0].push('data: 1\n\n');
  await until(() => got.length === 1);
  lives[0].end();
  await until(() => lives.length === 2);
  assert.equal(opened, 2);
  ac.abort();
  await done;
});

test('signing out ends an open stream, an event that arrives afterwards is not handed on, and it does not connect again', async () => {
  let live;
  const s = setup((c) => { if (c.method === 'DELETE') return json({ ok: true }); live = streamResponse(c.signal); return live.res; }, { sleep: async () => {} });
  signedIn(s);
  const got = [];
  const done = s.hub.stream('/api/me/events', (e, d) => got.push(d), { signal: new AbortController().signal });
  await until(() => live);
  live.push('event: order\ndata: {"id":"before"}\n\n');
  await until(() => got.length === 1);
  await s.hub.logout();
  live.push('event: order\ndata: {"id":"after"}\n\n');
  await done;
  assert.deepEqual(got, [{ id: 'before' }]);
  assert.equal(s.fetch.calls.filter((c) => c.url.endsWith('/api/me/events')).length, 1);
});

test('a stream the hub closes after a sign-out is not opened again', async () => {
  let live;
  const s = setup((c) => { if (c.method === 'DELETE') return json({ ok: true }); live = streamResponse(c.signal); return live.res; }, { sleep: async () => {} });
  signedIn(s);
  const done = s.hub.stream('/api/me/events', () => {}, { signal: new AbortController().signal });
  await until(() => live);
  await s.hub.logout();
  live.end();   // what the hub does when the token is revoked
  await done;
  assert.equal(s.fetch.calls.filter((c) => c.url.endsWith('/api/me/events')).length, 1);
});

test('a sign-in as someone else ends the stream held for the old token, and the next stream uses the new one', async () => {
  const lives = [];
  const s = setup((c) => { const l = streamResponse(c.signal); lives.push(l); return l.res; });
  signedIn(s);
  const got = [];
  const done = s.hub.stream('/api/me/events', (e, d) => got.push(d), { signal: new AbortController().signal });
  await until(() => lives.length === 1);
  signedIn(s, 'hub_other');   // a logout and a login as another account, from a terminal
  s.bump();
  lives[0].push('event: order\ndata: {"id":"for the old account"}\n\n');
  await done;
  assert.deepEqual(got, []);
  assert.equal(s.hub.status().loggedIn, true, 'the new sign-in is untouched');
  const ac = new AbortController();
  const next = s.hub.stream('/api/me/events', () => {}, { signal: ac.signal });
  await until(() => lives.length === 2);
  assert.equal(s.fetch.calls[1].headers.authorization, 'Bearer hub_other');
  ac.abort();
  await next;
});

test('a 401 for a token the file no longer holds ends the stream without signing the new one out', async () => {
  const s = setup(async () => { signedIn(s, 'hub_new'); s.bump(); return json({ ok: false }, 401); });
  signedIn(s);
  await s.hub.stream('/api/me/events', () => {}, { signal: new AbortController().signal });
  assert.equal(s.hub.status().loggedIn, true);
});

test('refreshAccount keeps a handle, name, picture or place changed on the hub, and writes nothing when none did', async () => {
  let account = { ...ACCOUNT, bio: 'not kept', visibility: 'public' };
  const s = setup(() => json({ ok: true, account }));
  signedIn(s);
  assert.equal(await s.hub.refreshAccount(), false, 'the same account');
  assert.equal(s.fetch.calls[0].url, 'http://hub.test/api/me');
  assert.equal(s.fetch.calls[0].headers.authorization, 'Bearer hub_secret');
  account = { ...account, handle: 'ada-l', avatar: 'https://avatars.githubusercontent.com/u/1' };
  assert.equal(await s.hub.refreshAccount(), true);
  assert.deepEqual(s.read().account, { id: 'a1', handle: 'ada-l', x: 3, y: -4, name: 'Ada', avatar: 'https://avatars.githubusercontent.com/u/1' });
  assert.equal(s.read().token, 'hub_secret');
  assert.equal(s.hub.status().account.handle, 'ada-l');
});

test('refreshAccount never throws and changes nothing when signed out, refused, unreachable, or signed in again meanwhile', async () => {
  const out = setup();
  assert.equal(await out.hub.refreshAccount(), false);
  assert.equal(out.fetch.calls.length, 0, 'signed out: nothing is asked');
  for (const answer of [() => json({ ok: false }, 500), () => { throw new Error('offline'); }, () => json({ ok: true, account: null }), () => new Response('nonsense')]) {
    const s = setup(answer);
    signedIn(s);
    assert.equal(await s.hub.refreshAccount(), false);
    assert.equal(s.read().account.handle, 'ada');
  }
  const s = setup(async () => { signedIn(s, 'hub_other'); s.bump(); return json({ ok: true, account: { ...ACCOUNT, handle: 'stale' } }); });
  signedIn(s);
  assert.equal(await s.hub.refreshAccount(), false);
  assert.equal(s.read().account.handle, 'ada');
});

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
