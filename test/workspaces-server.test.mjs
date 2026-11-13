// Workspaces, end to end: the real server on a throwaway home with two profiles (~/.claude and ~/.claude-contract), each
// a workspace, both live at once. The stand-in `claude` reads the roster of the profile it runs under (from
// CLAUDE_CONFIG_DIR) and logs every other call with that variable, so a test can see which profile a process ran on.
// Each page names itself (c= on its stream, x-acp-client on its calls) and is shown one workspace: the seal.
// Run with `npm test`. Starts the server on a spare port.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const PORT = 47800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-ws-'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const SID_D = 'aaaaaaaa-1111-4111-8111-111111111111', SID_C = 'cccccccc-2222-4222-8222-222222222222';
const SID_H = 'cccccccc-3333-4333-8333-333333333333', SID_N = 'eeeeeeee-4444-4444-8444-444444444444';

// Where each session works (the contract one in a folder of its own, so a test can look for it), and a conversation
// for each in its own profile, so a reply has something to resume.
const work = path.join(home, 'code', 'w'), workC = path.join(home, 'code', 'contract-w');
for (const d of [work, workC]) fs.mkdirSync(d, { recursive: true });
const transcript = (text, cwd) => [
  JSON.stringify({ type: 'user', cwd, permissionMode: 'default', timestamp: '2026-11-12T10:00:00.000Z', message: { role: 'user', content: text } }),
  JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-11-12T10:00:01.000Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }] } }),
].join('\n') + '\n';
for (const [dir, sid, cwd] of [['.claude', SID_D, work], ['.claude-contract', SID_C, workC]]) {
  fs.mkdirSync(path.join(home, dir, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, dir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(home, dir, 'projects', 'p', `${sid}.jsonl`), transcript(`work in ${dir}`, cwd));
}
// One background job per profile, up and idle with no process of its own: a reply resumes it with --bg.
const job = (sid, name, cwd) => ({ pid: null, id: sid.slice(0, 8), cwd, kind: 'background', startedAt: Date.now(), sessionId: sid, name, status: 'idle', state: 'running' });
fs.writeFileSync(path.join(home, 'roster-default.json'), JSON.stringify([job(SID_D, 'default job', work)]));
fs.writeFileSync(path.join(home, 'roster-.claude-contract.json'), JSON.stringify([job(SID_C, 'contract job', workC)]));

const calls = path.join(home, 'claude-calls.log');
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), cfg = process.env.CLAUDE_CONFIG_DIR ?? null;
if (a[0] === 'agents') {
  const f = path.join(${JSON.stringify(home)}, 'roster-' + (cfg ? path.basename(cfg) : 'default') + '.json');
  try { process.stdout.write(fs.readFileSync(f, 'utf8')); } catch { process.stdout.write('[]'); }
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: a, env: cfg }) + '\\n');
if (a[0] === 'auth') { console.log('{}'); process.exit(0); }
if (a[0] === '--bg') { const i = a.indexOf('--resume'); console.log('backgrounded · ' + (i >= 0 ? a[i + 1].slice(0, 8) : 'deadbeef')); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });

const prefs = path.join(home, 'panel', 'prefs.json');
fs.mkdirSync(path.dirname(prefs));
fs.writeFileSync(prefs, JSON.stringify({ profile: 'default' }));

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ACP_')));
const server = spawn(process.execPath, [SERVER], { env: { ...env, HOME: home, PATH: `${bin}:${env.PATH}`, ACP_PORT: String(PORT), ACP_PREFS: prefs, ACP_GITHUB: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { server.kill(); } catch {} });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start: ' + log)), 10_000);
  server.stdout.on('data', () => { if (log.includes(BASE)) { clearTimeout(t); resolve(); } });
  server.on('exit', () => reject(new Error('server exited: ' + log)));
});
const token = (await (await fetch(BASE + '/')).text()).match(/[0-9a-f]{48}/)[0];
const REFUSE = 'That belongs to another workspace. Switch to it to do this.';
/** A call as page `client` makes it (the page sends its id in x-acp-client). */
const api = (p, body, client) => fetch(BASE + p, { method: 'POST', body: JSON.stringify(body ?? {}),
  headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': token, ...(client ? { 'x-acp-client': client } : {}) } })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));

/** A page watching as `client` (its id on the stream, as the page sends c=). Frames arrive as they are sent. */
const pages = [];
function watch(client) {
  const frames = [], ctl = new AbortController();
  fetch(`${BASE}/events?t=${token}&c=${client}`, { signal: ctl.signal }).then(async (r) => {
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      for (const m of buf.matchAll(/^data: (.*)$/gm)) { try { frames.push(JSON.parse(m[1])); } catch {} }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
  }).catch(() => {});
  const pg = { client, frames, latest: () => frames.findLast((f) => Array.isArray(f?.sessions)), close: () => ctl.abort() };
  pages.push(pg);
  return pg;
}
async function until(fn, ms = 10_000, every = 100) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(every)) { const v = await fn(); if (v) return v; }
  return null;
}
const logged = () => { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const hookPost = (kind, e) => fetch(BASE + '/hook/' + kind, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) });
const sessionsOf = (snap) => (snap?.sessions ?? []).map((s) => s.sessionId);

// Page A stays on the plain profile's workspace; page B looks at contract. Both connect while the focus is default.
const A = watch('page-a'), B = watch('page-b');
await until(() => A.latest() && B.latest());

after(async () => { for (const p of pages) p.close(); if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); }); fs.rmSync(home, { recursive: true, force: true }); });

test('both workspaces\' sessions are live at once', async () => {
  const f = await api('/api/workspace/focus', { ws: 'contract' }, B.client);
  assert.equal(f.ok, true, JSON.stringify(f));
  const a = await until(() => A.latest()?.sessions.find((s) => s.sessionId === SID_D && s.inRoster));
  const b = await until(() => B.latest()?.sessions.find((s) => s.sessionId === SID_C && s.inRoster));
  assert.ok(a && b, `both rosters are read: A ${sessionsOf(A.latest())} B ${sessionsOf(B.latest())} | ${log}`);
  assert.equal(a.ws, 'default');
  assert.equal(b.ws, 'contract');
  assert.equal(A.latest().workspace?.id, 'default');
  assert.equal(B.latest().workspace?.id, 'contract');
  assert.equal(B.latest().profile.dir, path.join(home, '.claude-contract'));
});

// A contract permission request, held for the next two tests.
const eH = { session_id: SID_H, transcript_path: path.join(home, '.claude-contract', 'projects', 'p', `${SID_H}.jsonl`), cwd: workC,
             hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo contract' }, permission_mode: 'default' };
let held = null, heldAnswered = false;

test('a workspace\'s snapshot holds nothing from the other', async () => {
  held = hookPost('permission', eH).then(async (r) => { heldAnswered = true; return r.text(); });
  const p = await until(() => B.latest()?.pending?.find((x) => x.sessionId === SID_H));
  assert.ok(p, 'the contract page lists the request');
  assert.equal(p.ws, 'contract');
  assert.equal(heldAnswered, false, 'the request stays open');
  // A frame A got after the request was held.
  const n = A.frames.length;
  await api('/api/arm', { armed: true });
  const snap = await until(() => A.frames.slice(n).findLast((f) => Array.isArray(f?.sessions)));
  assert.ok(snap, 'page A got a frame');
  const text = JSON.stringify(snap);
  for (const bit of [SID_C, SID_C.slice(0, 8), 'contract job', workC, SID_H, p.id, 'echo contract'])
    assert.equal(text.includes(bit), false, `page A's snapshot carries ${bit}`);
  assert.ok(snap.sessions.some((s) => s.sessionId === SID_D), 'its own session is there');
  assert.deepEqual(snap.workspaces?.map((w) => w.id).sort(), ['contract', 'default']);
  for (const w of snap.workspaces) assert.deepEqual(Object.keys(w).sort(), ['color', 'id', 'name', 'waiting']);
  assert.equal(snap.workspaces.find((w) => w.id === 'contract').waiting, 1);
  assert.equal(snap.workspaces.find((w) => w.id === 'default').waiting, 0);
  assert.deepEqual(snap.workspace, { id: 'default', name: 'claude', color: 'violet' });
});

test('two pages, two workspaces', async () => {
  const a = A.latest(), b = B.latest();
  assert.ok(a.sessions.length && a.sessions.every((s) => s.ws === 'default'), JSON.stringify(a.sessions.map((s) => [s.sessionId, s.ws])));
  assert.ok(b.sessions.length && b.sessions.every((s) => s.ws === 'contract'), JSON.stringify(b.sessions.map((s) => [s.sessionId, s.ws])));
  assert.ok(b.pending.every((p) => p.ws === 'contract'));
  const p = b.pending.find((x) => x.sessionId === SID_H);
  assert.ok(p);
  const no = await api('/api/decide', { id: p.id, behavior: 'deny', message: 'not from here' }, A.client);
  assert.equal(no.status, 409);
  assert.equal(no.ok, false);
  assert.equal(no.error, REFUSE);
  assert.equal(heldAnswered, false, 'page A could not answer it');
  const yes = await api('/api/decide', { id: p.id, behavior: 'deny', message: 'not now' }, B.client);
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.match(await held, /"behavior":"deny"/);
});

test('every session action is guarded', async () => {
  const before = logged().length;
  const tries = [
    ['/api/reply', { sessionId: SID_C, text: 'from the wrong page' }],
    ['/api/end', { sessionId: SID_C }],
    ['/api/remove', { sessionId: SID_C }],
    ['/api/interrupt', { sessionId: SID_C }],
    ['/api/mode', { sessionId: SID_C, mode: 'plan' }],
    ['/api/term/open', { client: A.client, sessionId: SID_C, cols: 80, rows: 24 }],
    ['/api/history', { sessionId: SID_C }],
    ['/api/follow', { client: A.client, sessionId: SID_C }],
  ];
  for (const [route, body] of tries) {
    const r = await api(route, body, A.client);
    assert.equal(r.ok, false, `${route} went through: ${JSON.stringify(r)}`);
    assert.equal(r.error, REFUSE, `${route}: ${JSON.stringify(r)}`);
  }
  assert.equal(logged().length, before, 'nothing ran for it');
  assert.ok(A.latest().sessions.every((s) => s.sessionId !== SID_C));
  // From its own workspace's page, the same reads work.
  const h = await api('/api/history', { sessionId: SID_C }, B.client);
  assert.equal(h.ok, true, JSON.stringify(h));
  const fo = await api('/api/follow', { client: B.client, sessionId: SID_C }, B.client);
  assert.equal(fo.ok, true, JSON.stringify(fo));
  assert.equal((await api('/api/follow', { client: B.client, sessionId: null }, B.client)).ok, true);
});

test('a reply runs under the session\'s own profile', async () => {
  const r = await api('/api/reply', { sessionId: SID_C, text: 'carry on, contract' }, B.client);
  assert.equal(r.ok, true, JSON.stringify(r) + ' | ' + log);
  const c = logged().find((x) => x.args[0] === '--bg' && x.args.includes(SID_C));
  assert.ok(c, JSON.stringify(logged()));
  assert.deepEqual(c.args.slice(0, 3), ['--bg', '--resume', SID_C]);
  assert.ok(c.env?.endsWith('.claude-contract'), `ran under ${c.env}`);

  const d = await api('/api/reply', { sessionId: SID_D, text: 'carry on, default' }, A.client);
  assert.equal(d.ok, true, JSON.stringify(d));
  const cd = logged().find((x) => x.args[0] === '--bg' && x.args.includes(SID_D));
  assert.ok(cd, JSON.stringify(logged()));
  assert.equal(cd.env, null, 'the plain profile runs with no CLAUDE_CONFIG_DIR');
});

test('an event that names its transcript moves a session first seen without one to its workspace', async () => {
  const SID_X = 'cccccccc-5555-4555-8555-555555555555';
  // The focus is default, so an event that names no transcript is put there.
  assert.equal((await api('/api/workspace/focus', { ws: 'default' }, A.client)).ok, true);
  const e = { session_id: SID_X, cwd: workC, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, permission_mode: 'default' };
  assert.equal((await hookPost('event', e)).status, 200);
  assert.ok(await until(() => A.latest()?.sessions.some((s) => s.sessionId === SID_X)), 'first put in the focused workspace');
  await hookPost('event', { ...e, transcript_path: path.join(home, '.claude-contract', 'projects', 'p', `${SID_X}.jsonl`), hook_event_name: 'PostToolUse' });
  const moved = await until(() => B.latest()?.sessions.find((s) => s.sessionId === SID_X));
  assert.ok(moved, 'the contract page shows it once an event names its transcript');
  assert.equal(moved.ws, 'contract');
  assert.ok(await until(() => !A.latest()?.sessions.some((s) => s.sessionId === SID_X)), 'and page A no longer does');
});

test('a profile folder created after start becomes a workspace', async () => {
  fs.mkdirSync(path.join(home, '.claude-new', 'projects', 'p'), { recursive: true });
  const e = { session_id: SID_N, transcript_path: path.join(home, '.claude-new', 'projects', 'p', `${SID_N}.jsonl`), cwd: work,
              hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, permission_mode: 'default' };
  const r = await hookPost('event', e);
  assert.equal(r.status, 200);
  const N = watch('page-n');
  await until(() => N.latest());
  const f = await api('/api/workspace/focus', { ws: 'new' }, N.client);
  assert.equal(f.ok, true, JSON.stringify(f));
  // Within two roster ticks (3 s each).
  const snap = await until(() => { const s = N.latest(); return s?.sessions.some((x) => x.sessionId === SID_N) ? s : null; }, 7000);
  assert.ok(snap, 'the new profile\'s session shows up on a page focused there');
  assert.equal(snap.sessions.find((s) => s.sessionId === SID_N).ws, 'new');
  assert.equal(snap.workspaces.length, 3);
  for (const pg of [A, B]) assert.equal(pg.frames.some((x) => JSON.stringify(x).includes(SID_N)), false, `${pg.client} saw it`);
  assert.equal((await api('/api/workspace/focus', { ws: 'nope' }, N.client)).ok, false, 'an unknown workspace is refused');
});

test('GET /api/workspaces lists names and colours', async () => {
  const r = await fetch(BASE + '/api/workspaces', { headers: { 'x-acp-token': token, 'x-acp-client': A.client } }).then((x) => x.json());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.workspaces.map((w) => w.id).sort(), ['contract', 'default', 'new']);
  assert.ok(Array.isArray(r.assigned));
  assert.equal((await fetch(BASE + '/api/workspaces')).status, 403, 'not without the token');
});

test('a machine with no profile yet keeps no workspace for the stand-in', async (t) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-ws0-')), port = PORT + 100;
  const b = path.join(h, 'bin');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'claude'), '#!/bin/sh\ncase "$1" in agents) echo "[]";; auth) echo "{}";; *) exit 1;; esac\n', { mode: 0o755 });
  const pf = path.join(h, 'panel', 'prefs.json');
  const child = spawn(process.execPath, [SERVER], { env: { ...env, HOME: h, PATH: `${b}:${env.PATH}`, ACP_PORT: String(port), ACP_PREFS: pf, ACP_GITHUB: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('exit', r); child.kill(); }); fs.rmSync(h, { recursive: true, force: true }); });
  assert.ok(await until(() => out.includes(`127.0.0.1:${port}`)), 'it started: ' + out);
  const file = path.join(h, 'panel', 'workspaces.json');
  const saved = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  await pause(500);
  assert.equal(Object.hasOwn(saved()?.workspaces ?? {}, 'default'), false, `the stand-in was kept: ${JSON.stringify(saved())}`);
  // A profile made later is the first workspace kept, and the stand-in still is not.
  fs.mkdirSync(path.join(h, '.claude-work'));
  fs.writeFileSync(path.join(h, '.claude-work', 'settings.json'), '{}');
  const s = await until(() => (Object.hasOwn(saved()?.workspaces ?? {}, 'work') ? saved() : null), 8000);
  assert.ok(s, `the new profile is kept: ${JSON.stringify(saved())} | ${out}`);
  assert.deepEqual(Object.keys(s.workspaces), ['work']);
});
