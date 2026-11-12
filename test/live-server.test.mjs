// The open session's Chat, live: /api/follow, `event: thread` messages on /events, and the snapshot's events list.
// Spawns the real server on a temp HOME whose profiles (~/.claude-a, ~/.claude-b) hold the transcripts it follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net'; import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const SERVER = new URL('../server.mjs', import.meta.url).pathname;
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `check` every 10 ms until it returns something truthy, which it returns; null past `ms`. */
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await check(); if (v) return v; await sleep(10); } return null; };

const AT = Date.UTC(2026, 10, 4, 9, 0, 0);
const stamp = (n) => new Date(AT + n * 1000).toISOString();
// Transcript lines in the shapes Claude Code writes them.
const you = (text, n) => JSON.stringify({ parentUuid: null, type: 'user', message: { role: 'user', content: text }, uuid: `u${n}`, timestamp: stamp(n) });
const said = (text, n) => JSON.stringify({ parentUuid: `u${n}`, type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] }, uuid: `a${n}`, timestamp: stamp(n) });
const call = (id, name, input, n) => JSON.stringify({ parentUuid: `u${n}`, type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id, name, input }] }, uuid: `a${n}`, timestamp: stamp(n) });

/** A temp HOME with profiles a (shown) and b, and a server on it. Its children are stopped after the test. */
async function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-live-'));
  const projA = path.join(home, '.claude-a', 'projects', '-work-proj');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-b', 'projects'), { recursive: true });
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ACP_')));
  // No `claude` on PATH: the roster reads as an error instead of this machine's real sessions.
  Object.assign(env, { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CLAUDE_CONFIG_DIR: path.join(home, '.claude-a'),
                       ACP_PORT: String(port), ACP_PREFS: path.join(home, 'prefs.json'), ACP_RECONNECT_MS: '300', ACP_GITHUB: 'off' });
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.close();
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('exit', r); child.kill(); });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const html = await until(() => fetch(base + '/').then((r) => (r.ok ? r.text() : null), () => null), 8000);
  assert.ok(html, 'the server never answered: ' + out);
  const token = html.match(/const TOKEN = '([0-9a-f]+)'/)[1];
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-acp-token': token }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const hook = (p, e, signal) => fetch(base + '/hook/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e), signal });
  /** An /events stream for page `client`, parsed into { event, data } messages as they arrive. */
  async function stream(client = crypto.randomUUID()) {
    const msgs = [];
    let buf = '', req;
    await new Promise((resolve, reject) => {
      req = http.get({ host: '127.0.0.1', port, path: `/events?t=${token}&c=${client}` }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d;
          for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            let event = 'message'; const data = [];
            for (const l of block.split('\n')) { if (l.startsWith('event: ')) event = l.slice(7); else if (l.startsWith('data: ')) data.push(l.slice(6)); }
            if (data.length) msgs.push({ event, data: JSON.parse(data.join('\n')), at: Date.now() });
          }
        });
        res.on('error', () => {});
        resolve();
      });
      req.on('error', reject);
    });
    const s = { client, msgs, close: () => req.destroy(),
                /** The thread events this page was sent, flattened, each with the time it arrived. */
                thread: (sessionId) => msgs.filter((m) => m.event === 'thread' && m.data.sessionId === sessionId).flatMap((m) => m.data.events.map((ev) => ({ ...ev, at_: m.at }))) };
    streams.push(s);
    assert.ok(await until(() => msgs.length), 'no snapshot on connect');
    return s;
  }
  return { home, port, projA, api, hook, stream, log: () => out, pid: child.pid };
}
/** How many open files the server has on `file` (a watch holds one). */
const openOn = (pid, file) => execFileSync('lsof', ['-p', String(pid)]).toString().split('\n').filter((l) => l.endsWith(path.basename(file))).length;

test('follow returns the backfill and later lines arrive as thread events within 300 ms', async (t) => {
  const s = await setup(t), id = crypto.randomUUID(), file = path.join(s.projA, id + '.jsonl');
  fs.writeFileSync(file, [you('hello', 1), said('hi there', 2), call('toolu_1', 'Bash', { command: 'ls' }, 3)].join('\n') + '\n');
  const size = fs.statSync(file).size;
  const page = await s.stream();
  const r = await s.api('/api/follow', { client: page.client, sessionId: id });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.ok, true);
  assert.equal(r.more, false);
  assert.deepEqual(r.items.map((i) => i.who), ['you', 'claude', 'tool']);
  assert.deepEqual(r.items.map((i) => i.text ?? i.summary.text), ['hello', 'hi there', 'ls']);
  assert.ok(r.items.every((i) => !('input' in i)), 'a tool call input went to the page');
  assert.equal(r.items[2].key, 'tool:toolu_1');

  const t0 = Date.now();
  fs.appendFileSync(file, said('later', 4) + '\n');
  const got = await until(() => page.thread(id).find((e) => e.text === 'later'), 3000);
  assert.ok(got, 'the appended line never arrived; log: ' + s.log());
  assert.ok(got.at_ - t0 < 300, `took ${got.at_ - t0} ms`);
  assert.equal(got.who, 'claude');
  assert.equal(got.pos, size);
  assert.equal(page.thread(id).length, 1, 'the backfill was sent as events too');
  assert.equal(s.log().includes('Error'), false, s.log());
});

test('two clients following one session share one watcher and both receive items; one closing keeps the other fed', async (t) => {
  const s = await setup(t), id = crypto.randomUUID(), file = path.join(s.projA, id + '.jsonl');
  fs.writeFileSync(file, you('hello', 1) + '\n');
  const one = await s.stream(), two = await s.stream();
  const [a, b] = await Promise.all([s.api('/api/follow', { client: one.client, sessionId: id }), s.api('/api/follow', { client: two.client, sessionId: id })]);
  assert.deepEqual(a.items.map((i) => i.text), ['hello']);
  assert.deepEqual(b.items.map((i) => i.text), ['hello']);
  await sleep(100);
  assert.equal(openOn(s.pid, file), 1, 'not one watcher on the transcript');

  fs.appendFileSync(file, said('to both', 2) + '\n');
  assert.ok(await until(() => one.thread(id).some((e) => e.text === 'to both')), 'first page not fed');
  assert.ok(await until(() => two.thread(id).some((e) => e.text === 'to both')), 'second page not fed');

  one.close();
  await sleep(500); // past ACP_RECONNECT_MS: the follow stays, the other page still has it open
  fs.appendFileSync(file, said('to the second', 3) + '\n');
  assert.ok(await until(() => two.thread(id).some((e) => e.text === 'to the second')), 'second page not fed after the first left');
  assert.equal(one.thread(id).length, 1);
  assert.equal(openOn(s.pid, file), 1);

  two.close();
  assert.ok(await until(() => openOn(s.pid, file) === 0, 3000), 'the follow outlived its last page');
});

test('a PreToolUse hook POSTed to /hook/event reaches the thread as an update', async (t) => {
  const s = await setup(t), id = crypto.randomUUID(), file = path.join(s.projA, id + '.jsonl');
  fs.writeFileSync(file, [you('list it', 1), call('toolu_1', 'Bash', { command: 'ls' }, 2)].join('\n') + '\n');
  const page = await s.stream();
  await s.api('/api/follow', { client: page.client, sessionId: id });
  const e = { session_id: id, transcript_path: file, cwd: '/work/proj', permission_mode: 'default' };
  // Not in the transcript yet: the hook's row stands in for it, then PostToolUse finishes it.
  const pre = await s.hook('event', { ...e, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 'toolu_2' });
  assert.equal(pre.status, 200);
  assert.equal(await pre.text(), '', 'the hook got a reply it does not get today');
  const row = await until(() => page.thread(id).find((ev) => ev.key === 'tool:toolu_2'));
  assert.ok(row, 'the PreToolUse never reached the thread');
  assert.equal(row.state, 'running');
  assert.equal('input' in row, false);
  await s.hook('event', { ...e, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 'toolu_2' });
  const up = await until(() => page.thread(id).find((ev) => ev.who === 'update' && ev.key === 'tool:toolu_2'));
  assert.ok(up, 'no update for PostToolUse');
  assert.equal(up.patch.state, 'done');
  assert.equal(typeof up.patch.endedAt, 'number');
  // The hook's existing effects stand: the session is on the board with its last tool.
  const snap = await until(() => page.msgs.findLast((m) => m.event === 'message' && m.data.sessions?.some((x) => x.sessionId === id))?.data);
  assert.equal(snap.sessions.find((x) => x.sessionId === id).lastTool.tool, 'Read');
});

test('a held permission request marks its tool row waiting, and settling it records why', async (t) => {
  const s = await setup(t), id = crypto.randomUUID(), file = path.join(s.projA, id + '.jsonl');
  fs.writeFileSync(file, [you('edit it', 1), call('toolu_9', 'Edit', { file_path: '/x' }, 2)].join('\n') + '\n');
  const page = await s.stream();
  await s.api('/api/follow', { client: page.client, sessionId: id });
  const held = s.hook('permission', { session_id: id, transcript_path: file, hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: '/x' } });
  const wait = await until(() => page.thread(id).find((ev) => ev.who === 'update' && ev.key === 'tool:toolu_9' && ev.patch.waiting === true));
  assert.ok(wait, 'the held request never marked the row waiting');
  const req = await until(() => page.msgs.findLast((m) => m.data.pending?.length)?.data.pending[0]);
  assert.equal(req.toolUseId, null); // a real PermissionRequest carries no tool_use_id: the row is found by its tool and input
  const d = await s.api('/api/decide', { id: req.id, behavior: 'deny', message: 'no' });
  assert.equal(d.ok, true);
  assert.equal((await held).status, 200);
  const done = await until(() => page.thread(id).find((ev) => ev.who === 'update' && ev.key === 'tool:toolu_9' && 'settledWhy' in ev.patch));
  assert.ok(done, 'settling sent nothing');
  assert.equal(done.patch.settledWhy, 'deny');
  assert.equal(done.patch.waiting, false);
});

test('a follow for a session with no transcript yet turns live when the file appears', async (t) => {
  const s = await setup(t), id = crypto.randomUUID(), file = path.join(s.projA, id + '.jsonl');
  const page = await s.stream();
  const r = await s.api('/api/follow', { client: page.client, sessionId: id });
  assert.deepEqual({ ...r, status: undefined }, { ok: true, items: [], more: false, pending: true, status: undefined });
  await sleep(300);
  fs.writeFileSync(file, [you('first', 1), said('reply', 2)].join('\n') + '\n');
  assert.ok(await until(() => page.thread(id).some((e) => e.text === 'reply'), 4000), 'the backfill never came: ' + s.log());
  assert.deepEqual(page.thread(id).map((e) => e.text), ['first', 'reply']);
  fs.appendFileSync(file, said('then this', 3) + '\n');
  assert.ok(await until(() => page.thread(id).some((e) => e.text === 'then this')), 'not live after the file appeared');
});

test('broadcasts close together ride the snapshots as events lists, each event once', async (t) => {
  const s = await setup(t), id = crypto.randomUUID();
  const page = await s.stream();
  const stop = new AbortController();
  t.after(() => stop.abort());
  const e = (n) => ({ session_id: id, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo ' + n } });
  const held = [s.hook('permission', e(1), stop.signal), s.hook('permission', e(2), stop.signal)];
  held.forEach((p) => p.catch(() => {}));
  // Two separate POSTs may or may not land in one tick, so what is asserted is the union of the snapshots' events.
  const carried = () => page.msgs.filter((m) => m.event === 'message' && m.data.events?.length).map((m) => m.data);
  const snaps = await until(() => { const c = carried(); return c.flatMap((d) => d.events).length >= 2 && c; });
  assert.ok(snaps, 'the snapshots never carried both events');
  for (const d of snaps) assert.equal('event' in d, false);
  assert.deepEqual(snaps.flatMap((d) => d.events.map((ev) => ev.type)), ['new-request', 'new-request']);
  assert.equal(snaps.at(-1).pending.length, 2);
});

test('a profile switch drops the follow: thread-reset arrives, and a line appended to the old transcript afterwards sends nothing', async (t) => {
  const s = await setup(t), id = crypto.randomUUID(), file = path.join(s.projA, id + '.jsonl');
  fs.writeFileSync(file, you('hello', 1) + '\n');
  const page = await s.stream();
  await s.api('/api/follow', { client: page.client, sessionId: id });
  fs.appendFileSync(file, said('before', 2) + '\n');
  assert.ok(await until(() => page.thread(id).some((e) => e.text === 'before')));
  const sw = await s.api('/api/profile', { id: 'b' });
  assert.equal(sw.ok, true, JSON.stringify(sw));
  const reset = await until(() => page.msgs.find((m) => m.event === 'thread-reset'));
  assert.ok(reset, 'no thread-reset');
  assert.deepEqual(reset.data, { sessionId: id });
  const n = page.msgs.length;
  fs.appendFileSync(file, said('after', 3) + '\n');
  await sleep(600);
  assert.equal(page.msgs.slice(n).filter((m) => m.event === 'thread').length, 0, 'the old transcript is still followed');
  assert.equal(openOn(s.pid, file), 0);
});
