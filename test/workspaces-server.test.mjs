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
import net from 'node:net';
// A port the system says is free: fixed ranges collided when test files ran side by side (EADDRINUSE).
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const PORT = await freePort();
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
// The contract profile's account, which a page shown the plain profile must never be able to read.
const EMAIL_C = 'contract-person@example.test';
fs.writeFileSync(path.join(home, '.claude-contract', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: EMAIL_C, organizationName: 'Contract Org' } }));
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
// Signed in on contract only, as someone a page shown the plain profile must not learn of.
if (a[0] === 'auth') { console.log(cfg && path.basename(cfg) === '.claude-contract' ? JSON.stringify({ loggedIn: true, email: ${JSON.stringify(EMAIL_C)}, orgName: 'Contract Org' }) : '{}'); process.exit(0); }
if (a[0] === '--bg') { const i = a.indexOf('--resume'); console.log('backgrounded · ' + (i >= 0 ? a[i + 1].slice(0, 8) : 'deadbeef')); process.exit(0); }
if (a[0] === '-p') {
  // The overseer's call (its prompt is the last argument, logged above): it answers after a moment, saying whose login it ran on.
  const v = { reply: 'Answered on ' + (cfg ? path.basename(cfg) : 'default') + '.', actions: [], look: [] };
  setTimeout(() => { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: JSON.stringify(v), structured_output: v })); process.exit(0); }, 400);
} else process.exit(1);
`, { mode: 0o755 });

const prefs = path.join(home, 'panel', 'prefs.json');
fs.mkdirSync(path.dirname(prefs));
fs.writeFileSync(prefs, JSON.stringify({ profile: 'default' }));
// The shared overseer file from before workspaces: each workspace's own is seeded from it once.
const oldOverseer = path.join(home, 'panel', 'overseer.json');
fs.writeFileSync(oldOverseer, JSON.stringify({ v: 1, model: 'haiku', profiles: { contract: { seq: 1, fseq: 0, feed: [],
  turns: [{ id: 't1', at: 1, who: 'you', text: 'kept from before, contract' }] } } }), { mode: 0o600 });

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

/** A page whose stream also keeps its named events (`event: thread` and the like), as `{ name, data }`. */
function streamOf(client) {
  const frames = [], named = [], ctl = new AbortController();
  fetch(`${BASE}/events?t=${token}&c=${client}`, { signal: ctl.signal }).then(async (r) => {
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
        const block = buf.slice(0, i), name = block.match(/^event: (.*)$/m)?.[1] ?? null, data = block.match(/^data: (.*)$/m)?.[1];
        buf = buf.slice(i + 2);
        let v;
        try { v = JSON.parse(data); } catch { continue; }
        if (name) named.push({ name, data: v, raw: block }); else frames.push(v);
      }
    }
  }).catch(() => {});
  const pg = { client, frames, named, latest: () => frames.findLast((f) => Array.isArray(f?.sessions)), close: () => ctl.abort() };
  pages.push(pg);
  return pg;
}

test('a session\'s live thread goes only to pages shown its workspace', async () => {
  // Two pages look at contract and open the contract job's Chat. Then one of them moves to default.
  const X = streamOf('page-x'), Y = streamOf('page-y');
  assert.ok(await until(() => X.latest() && Y.latest()));
  for (const pg of [X, Y]) {
    assert.equal((await api('/api/workspace/focus', { ws: 'contract' }, pg.client)).ok, true);
    const fo = await api('/api/follow', { client: pg.client, sessionId: SID_C }, pg.client);
    assert.equal(fo.ok, true, JSON.stringify(fo));
  }
  assert.equal((await api('/api/workspace/focus', { ws: 'default' }, X.client)).ok, true);
  assert.ok(await until(() => X.latest()?.workspace?.id === 'default'));
  // The contract job writes on: page Y, still on contract, gets it live; page X gets nothing of that session.
  const SECRET = 'contract line nobody on default may read';
  fs.appendFileSync(path.join(home, '.claude-contract', 'projects', 'p', `${SID_C}.jsonl`), JSON.stringify({ parentUuid: null, uuid: 'a-secret', type: 'assistant', cwd: workC,
    timestamp: '2026-11-12T10:05:00.000Z', message: { id: 'msg_secret', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: SECRET }] } }) + '\n');
  const got = await until(() => Y.named.find((e) => e.name === 'thread' && e.data.sessionId === SID_C && JSON.stringify(e.data).includes(SECRET)), 5000);
  assert.ok(got, 'page Y got the line live: ' + JSON.stringify(Y.named.map((e) => e.name)) + ' | ' + log);
  await pause(300);
  const leaked = X.named.filter((e) => e.data?.sessionId === SID_C || e.raw.includes(SECRET));
  assert.deepEqual(leaked.map((e) => e.name), [], 'page X got a stream event for the contract job');
  assert.equal(X.frames.some((f) => JSON.stringify(f).includes(SECRET)), false, 'a snapshot carried the line to page X');
  // Nor can it open the session again from default.
  const again = await api('/api/follow', { client: X.client, sessionId: SID_C }, X.client);
  assert.equal(again.ok, false, JSON.stringify(again));
  assert.equal(again.error, REFUSE);
  assert.equal((await api('/api/follow', { client: Y.client, sessionId: null }, Y.client)).ok, true);
  X.close();
  Y.close();
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

/** The overseer's turns as page `pg` sees them, once its newest is an answer (null if none comes). */
const answered = (pg) => until(async () => {
  const r = await api('/api/overseer/turns', {}, pg.client);
  return r.ok && r.turns.at(-1)?.who === 'overseer' ? r.turns : null;
});

test('the old shared overseer file seeds each workspace\'s own once, and stays', async () => {
  const b = await api('/api/overseer/turns', {}, B.client);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(b.turns.map((t) => t.text), ['kept from before, contract']);
  const a = await api('/api/overseer/turns', {}, A.client);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual(a.turns, [], 'default never had a conversation');
  const own = path.join(home, 'panel', 'overseer-contract.json');
  assert.equal(fs.statSync(own).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(own, 'utf8')).model, 'haiku', 'the old file\'s model');
  assert.ok(fs.existsSync(oldOverseer), 'the old file is left in place');
  assert.equal(B.latest().overseer?.model, 'haiku');
  assert.ok(A.latest().overseer, 'each page has its own workspace\'s overseer');
});

test('each overseer reads only its own workspace', async () => {
  const before = logged().length;
  const r = await api('/api/overseer/say', { text: 'What is going on?' }, A.client);
  assert.equal(r.ok, true, JSON.stringify(r));
  const turns = await answered(A);
  assert.ok(turns, 'it answered: ' + log);
  assert.equal(turns.at(-1).error, undefined, JSON.stringify(turns.at(-1)));
  assert.equal(turns.at(-1).text, 'Answered on default.');
  const asks = logged().slice(before).filter((x) => x.args[0] === '-p');
  assert.equal(asks.length, 1, JSON.stringify(asks));
  assert.equal(asks[0].env, null, 'on the plain profile\'s login');
  const prompt = asks[0].args.at(-1);
  assert.ok(prompt.includes(SID_D.slice(0, 8)) || prompt.includes('default job'), 'its own session is on its board');
  for (const bit of [SID_C.slice(0, 8), 'contract job', workC, 'kept from before'])
    assert.equal(prompt.includes(bit), false, `the default overseer's prompt carries ${bit}`);
});

test('both overseers can answer at once', async () => {
  const before = logged().length;
  const [a, b] = await Promise.all([
    api('/api/overseer/say', { text: 'Anything for default?' }, A.client),
    pause(50).then(() => api('/api/overseer/say', { text: 'Anything for contract?' }, B.client)),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  const [ta, tb] = await Promise.all([answered(A), answered(B)]);
  assert.ok(ta && tb, 'both answered: ' + log);
  for (const t of [...ta, ...tb]) assert.notEqual(t.error, 'You switched profile before it answered.');
  assert.deepEqual([ta.at(-2).text, ta.at(-1).text, ta.at(-1).error], ['Anything for default?', 'Answered on default.', undefined]);
  assert.deepEqual([tb.at(-2).text, tb.at(-1).text, tb.at(-1).error], ['Anything for contract?', 'Answered on .claude-contract.', undefined]);
  const asks = logged().slice(before).filter((x) => x.args[0] === '-p');
  assert.ok(asks.find((x) => x.env === null).args.at(-1).includes('Anything for default?'));
  const c = asks.find((x) => x.env?.endsWith('.claude-contract'));
  assert.ok(c, JSON.stringify(asks.map((x) => x.env)));
  assert.ok(c.args.at(-1).includes('Anything for contract?') && c.args.at(-1).includes('kept from before, contract'));
  assert.equal(c.args.at(-1).includes(SID_D.slice(0, 8)), false, 'the contract overseer\'s prompt carries no default session');
  assert.equal(c.args[2], 'haiku', 'its own model');
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

test('a profile folder made after start is a login in no workspace: its sessions show nowhere until one uses it', async () => {
  fs.mkdirSync(path.join(home, '.claude-new', 'projects', 'p'), { recursive: true });
  const e = { session_id: SID_N, transcript_path: path.join(home, '.claude-new', 'projects', 'p', `${SID_N}.jsonl`), cwd: work,
              hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, permission_mode: 'default' };
  assert.equal((await hookPost('event', e)).status, 200);
  const settings = () => fetch(BASE + '/api/settings', { headers: { 'x-acp-token': token, 'x-acp-client': A.client } }).then((x) => x.json());
  const found = (await until(async () => (await settings()).logins.find((l) => l.id === 'new')));
  assert.ok(found, 'the folder is a login now');
  assert.deepEqual(found.users, [], 'used by no workspace');
  assert.equal((await settings()).workspaces.length, 2, 'and no workspace was made for it');
  await pause(300);
  for (const pg of [A, B]) assert.equal(pg.frames.some((x) => JSON.stringify(x).includes(SID_N)), false, `${pg.client} saw it`);
  // A workspace you make, using that login: its session shows there, and only there.
  const N = watch('page-n');
  await until(() => N.latest());
  const made = await api('/api/workspace/create', { name: 'New' }, N.client);
  assert.deepEqual(made, { status: 200, ok: true, id: 'new' });
  assert.equal((await api('/api/login/attach', { ws: 'new', id: 'new' }, N.client)).ok, true);
  assert.equal((await api('/api/workspace/focus', { ws: 'new' }, N.client)).ok, true);
  const snap = await until(() => { const s = N.latest(); return s?.sessions.some((x) => x.sessionId === SID_N) ? s : null; }, 7000);
  assert.ok(snap, 'its session shows on a page focused on the workspace that uses its login');
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

// A repository nobody has sorted yet, on GitHub as o/n, and a launch into it as a page makes one.
const repoN = path.join(home, 'code', 'n');
fs.mkdirSync(path.join(repoN, '.git'), { recursive: true });
fs.writeFileSync(path.join(repoN, '.git', 'HEAD'), 'ref: refs/heads/main\n');
fs.writeFileSync(path.join(repoN, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:o/n.git\n');
const launchIn = (cwd, client, extra = {}) => api('/api/launch', { prompt: `work in ${client}`, cwd, model: '', mode: 'default', ...extra }, client);
const launchedBy = (client, from) => logged().slice(from).filter((x) => x.args[0] === '--bg' && x.args.at(-1) === `work in ${client}`);
const assignedOf = async (client) => (await fetch(BASE + '/api/workspaces', { headers: { 'x-acp-token': token, 'x-acp-client': client } }).then((x) => x.json())).assigned;

test('an unsorted folder asks before launching', async () => {
  const f = await api('/api/folder', { path: repoN }, A.client);
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.deepEqual(f.workspaces, { key: 'gh:o/n', label: 'n', in: [], suggest: null });
  const before = logged().length;
  const r = await launchIn(repoN, A.client);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.ask?.label, 'n', JSON.stringify(r));
  assert.deepEqual(r.ask, { key: 'gh:o/n', label: 'n', suggest: null });
  assert.equal(launchedBy(A.client, before).length, 0, 'nothing ran before the answer');
  assert.deepEqual(await assignedOf(A.client), [], 'nothing was sorted');
});

test('assign then launch', async () => {
  const before = logged().length;
  const r = await launchIn(repoN, A.client, { assign: ['default'] });
  assert.equal(r.ok, true, JSON.stringify(r) + ' | ' + log);
  const runs = launchedBy(A.client, before);
  assert.equal(runs.length, 1, JSON.stringify(logged().slice(before)));
  assert.equal(runs[0].env, null, 'under the plain profile, the focus of page A');
  assert.deepEqual(await assignedOf(A.client), [{ key: 'gh:o/n', ws: ['default'] }]);
  assert.deepEqual((await api('/api/folder', { path: repoN }, A.client)).workspaces.in, ['default']);
  // Sorted now: no question the second time, and an `assign` sent anyway changes nothing.
  const again = await launchIn(repoN, A.client, { assign: ['contract'] });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(await assignedOf(A.client), [{ key: 'gh:o/n', ws: ['default'] }]);
});

test('a folder in another workspace is refused', async () => {
  const mv = await api('/api/workspace/assign', { key: 'gh:o/n', ws: ['contract'] }, A.client);
  assert.deepEqual(mv, { status: 200, ok: true });
  // Page A can no longer move it: it is not in A's workspace any more.
  const back = await api('/api/workspace/assign', { key: 'gh:o/n', ws: ['default'] }, A.client);
  assert.equal(back.ok, false);
  assert.equal(back.error, REFUSE);
  assert.deepEqual(await assignedOf(A.client), []);
  const before = logged().length;
  const r = await launchIn(repoN, A.client);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, 'n is in claude-contract. Switch to claude-contract to start an agent there.');
  assert.equal(launchedBy(A.client, before).length, 0, 'nothing ran');
  assert.deepEqual((await api('/api/folder', { path: repoN }, A.client)).workspaces.in, ['contract']);
  // From the contract page it launches, under the contract profile.
  const b = await launchIn(repoN, B.client);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.ok(launchedBy(B.client, before)[0]?.env?.endsWith('.claude-contract'), JSON.stringify(logged().slice(before)));
  // In both: both pages launch there.
  assert.equal((await api('/api/workspace/assign', { key: 'gh:o/n', ws: ['contract', 'default'] }, B.client)).ok, true);
  assert.equal((await launchIn(repoN, A.client)).ok, true);
  assert.equal(launchedBy(A.client, before).length, 1);
  // Nonsense is refused.
  assert.equal((await api('/api/workspace/assign', { key: 'gh:o/n', ws: ['nope'] }, A.client)).ok, false);
  assert.equal((await api('/api/workspace/assign', { key: 'whatever', ws: ['default'] }, A.client)).ok, false);
});

test('a folder only one workspace\'s sessions worked in suggests that workspace', async () => {
  // Only contract's sessions worked in workC (not a git repository, so it is sorted as the folder itself).
  const c = await api('/api/folder', { path: workC }, A.client);
  assert.deepEqual(c.workspaces, { key: `dir:${workC}`, label: 'contract-w', in: [], suggest: 'contract' });
  const r = await launchIn(workC, A.client);
  assert.deepEqual(r.ask, { key: `dir:${workC}`, label: 'contract-w', suggest: 'contract' });
  // Sessions of two workspaces worked in `work` (default's, and the new profile's): no suggestion.
  assert.equal((await api('/api/folder', { path: work }, A.client)).workspaces.suggest, null);
});

test('a page forgets a repository only for its own workspace', async () => {
  // o/n is in both, from the test before last. Page A (default) forgetting it leaves contract's hold alone.
  assert.deepEqual((await assignedOf(B.client)).find((a) => a.key === 'gh:o/n')?.ws.sort(), ['contract', 'default']);
  assert.deepEqual(await api('/api/workspace/assign', { key: 'gh:o/n', ws: [] }, A.client), { status: 200, ok: true });
  assert.deepEqual(await assignedOf(B.client), [{ key: 'gh:o/n', ws: ['contract'] }]);
  assert.deepEqual(await assignedOf(A.client), []);
});

// A default-profile session started in a terminal in o/n, on branch feat/x.
const SID_R = 'bbbbbbbb-6666-4666-8666-666666666666';
const inRepoN = () => hookPost('event', { session_id: SID_R, transcript_path: path.join(home, '.claude', 'projects', 'p', `${SID_R}.jsonl`), cwd: repoN,
  hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, permission_mode: 'default' });

test('a session in an unsorted repository is asked about', async () => {
  // Page B forgets it for contract, the last workspace holding it: o/n is in none now.
  assert.equal((await api('/api/workspace/assign', { key: 'gh:o/n', ws: [] }, B.client)).ok, true);
  assert.deepEqual(await assignedOf(B.client), []);
  fs.writeFileSync(path.join(repoN, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
  assert.equal((await inRepoN()).status, 200);
  const s = await until(() => { const x = A.latest()?.sessions.find((y) => y.sessionId === SID_R); return x?.git?.branch === 'feat/x' ? x : null; });
  assert.ok(s, 'page A shows the session, on its branch: ' + JSON.stringify(A.latest()?.sessions.find((y) => y.sessionId === SID_R)));
  assert.equal(s.repoAsk?.label, 'n', JSON.stringify(s.repoAsk));
  assert.equal(s.repoAsk.key, 'gh:o/n');
  // Until it is answered, everything shows as before.
  assert.equal(s.mismatch, null);
  assert.equal(s.workCwd, repoN);
  assert.equal(s.cwd, repoN);
  // A session of its own workspace in a repository that workspace holds is asked nothing.
  const d = A.latest().sessions.find((y) => y.sessionId === SID_D);
  assert.ok(d);
  assert.equal(d.mismatch, null);
});

test('a session in another workspace\'s repository shows nothing of it', async () => {
  // "It's claude-contract", from the contract page: o/n → ['contract'].
  assert.equal((await api('/api/workspace/assign', { key: 'gh:o/n', ws: ['contract'] }, B.client)).ok, true);
  const s = await until(() => A.latest()?.sessions.find((y) => y.sessionId === SID_R && y.mismatch));
  assert.ok(s, 'page A marks the session: ' + JSON.stringify(A.latest()?.sessions.find((y) => y.sessionId === SID_R)));
  assert.equal(s.mismatch.name, 'claude-contract');
  assert.equal(s.repoAsk, null);
  for (const k of ['git', 'elsewhere', 'gh', 'workCwd', 'cwd']) assert.equal(s[k], null, k);
  const text = JSON.stringify(s);
  for (const bit of ['o/n', 'feat/x', repoN]) assert.equal(text.includes(bit), false, `the session carries ${bit}: ${text}`);
  // Its own data still shows: it came from its own login.
  assert.equal(s.ws, 'default');
  assert.equal(s.lastTool?.tool, 'Read');
  // Its workspace's overseer sees the same: no repository, branch or folder for it.
  const before = logged().length;
  assert.equal((await api('/api/overseer/say', { text: 'Where does everyone work?' }, A.client)).ok, true);
  assert.ok(await answered(A), 'it answered: ' + log);
  const ask = logged().slice(before).find((x) => x.args[0] === '-p');
  assert.ok(ask, JSON.stringify(logged().slice(before)));
  const prompt = ask.args.at(-1);
  const id8 = SID_R.slice(0, 8), at = prompt.indexOf(`[${id8}]`);
  assert.ok(at >= 0, 'the session is on its board');
  // Its block on the board, and the folders a launch may use. (The feed keeps page A's own launch in o/n, from when A held it.)
  const block = prompt.slice(at).split('\n\n')[0], folders = prompt.slice(prompt.indexOf('Folders a new session can start in:')).split('\n\n')[0];
  assert.match(block, new RegExp(`^\\[${id8}\\] "${id8}"`), 'named by its id, not its folder');
  for (const bit of ['feat/x', repoN, '~/code/n', ' n @ ']) assert.equal(block.includes(bit), false, `its board block carries ${bit}: ${block}`);
  assert.equal(folders.includes('~/code/n'), false, folders);
});

test('a held request on that session carries nothing of the repository either', async () => {
  const e = { session_id: SID_R, transcript_path: path.join(home, '.claude', 'projects', 'p', `${SID_R}.jsonl`), cwd: repoN,
              hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo held' }, permission_mode: 'default' };
  const reply = hookPost('permission', e).then((r) => r.text());
  const n = A.frames.length;
  const frame = await until(() => A.frames.slice(n).findLast((f) => f?.pending?.some((p) => p.sessionId === SID_R && p.toolInput?.command === 'echo held')));
  assert.ok(frame, 'page A lists the request');
  // The whole frame, not only the session: the request sits beside it.
  const text = JSON.stringify(frame);
  for (const bit of [repoN, 'o/n', 'feat/x']) assert.equal(text.includes(bit), false, `page A's frame carries ${bit}`);
  const p = frame.pending.find((x) => x.sessionId === SID_R);
  assert.equal((await api('/api/decide', { id: p.id, behavior: 'deny', message: 'not now' }, A.client)).ok, true);
  assert.match(await reply, /"behavior":"deny"/);
});

test('a page may sort an unsorted repository into another workspace, but not claim one', async () => {
  const dirU = path.join(home, 'code', 'u'), key = `dir:${dirU}`;
  fs.mkdirSync(dirU, { recursive: true });
  // "It's claude-contract" from the default page, on a repository in no workspace.
  assert.deepEqual(await api('/api/workspace/assign', { key, ws: ['contract'] }, A.client), { status: 200, ok: true });
  assert.deepEqual((await assignedOf(B.client)).find((a) => a.key === key), { key, ws: ['contract'] });
  // Now it is contract's: the default page can't add itself to it.
  for (const ws of [['default'], ['contract', 'default']]) {
    const r = await api('/api/workspace/assign', { key, ws }, A.client);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, REFUSE);
  }
  assert.deepEqual((await assignedOf(B.client)).find((a) => a.key === key), { key, ws: ['contract'] });
  assert.equal((await assignedOf(A.client)).some((a) => a.key === key), false);
});

test('a page shown one workspace can read no other workspace\'s account, by any route', async () => {
  assert.equal((await api('/api/workspace/focus', { ws: 'contract' }, B.client)).ok, true);
  assert.equal((await api('/api/workspace/focus', { ws: 'default' }, A.client)).ok, true);
  // The contract page sees its own account: the control.
  assert.ok(await until(() => B.latest()?.profile?.account?.email === EMAIL_C), `B: ${JSON.stringify(B.latest()?.profile)}`);
  const seen = [];
  for (const [route, body] of [['/api/profiles', {}], ['/api/profile', { id: 'contract' }], ['/api/setup/check', {}], ['/api/profile/connect', { id: 'contract' }],
    ['/api/folder', { dir: path.join(home, '.claude-contract') }], ['/api/folders', { typed: home + '/' }], ['/api/github/refresh', {}]]) {
    const r = await api(route, body, A.client);
    seen.push(r);
  }
  seen.push(await fetch(BASE + '/api/workspaces', { headers: { 'x-acp-token': token, 'x-acp-client': A.client } }).then((x) => x.json()));
  for (const f of A.frames) seen.push(f);
  // Connecting another workspace's hooks is allowed on purpose (Settings' Logins tab), and says nothing of its account.
  assert.equal(seen[3].ok, true, 'page A may connect the contract profile\'s hooks: ' + JSON.stringify(seen[3]));
  assert.ok(fs.readFileSync(path.join(home, '.claude-contract', 'settings.json'), 'utf8').includes('/hook/'), 'its settings gained the hooks');
  const text = JSON.stringify(seen);
  assert.equal(text.includes(EMAIL_C), false, 'page A read the contract profile\'s email');
  assert.equal(text.includes('Contract Org'), false, 'page A read the contract profile\'s organisation');
  assert.equal(A.latest().workspace.id, 'default');
  // The old profile list is gone: nothing answers there any more.
  assert.equal((await api('/api/profiles', {}, A.client)).status, 404);
});

test('switching never asks first: a message waiting for a busy session stays waiting, and is still there on the way back', async (t) => {
  // A terminal session of the plain profile, busy, so a reply to it waits in its inbox.
  const sid = 'dddddddd-5555-4555-8555-555555555555', proc = spawn('sleep', ['60']);
  t.after(() => proc.kill());
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', `${sid}.jsonl`), JSON.stringify({ type: 'user', cwd: work, timestamp: '2026-11-12T10:00:00.000Z', message: { role: 'user', content: 'keep going' } }) + '\n');
  const rosterD = path.join(home, 'roster-default.json'), before = fs.readFileSync(rosterD, 'utf8');
  t.after(() => fs.writeFileSync(rosterD, before));
  fs.writeFileSync(rosterD, JSON.stringify([...JSON.parse(before), { pid: proc.pid, id: sid.slice(0, 8), cwd: work, kind: 'interactive', startedAt: Date.now(), sessionId: sid, name: 'busy one', status: 'busy', state: 'running' }]));
  assert.equal((await api('/api/workspace/focus', { ws: 'default' }, A.client)).ok, true);
  assert.ok(await until(() => A.latest()?.sessions.find((s) => s.sessionId === sid && s.working), 8000), `the busy session shows: ${log}`);
  const r = await api('/api/reply', { sessionId: sid, text: 'after this, the tests' }, A.client);
  assert.equal(r.queued, true, JSON.stringify(r));
  const f = await api('/api/workspace/focus', { ws: 'contract' }, A.client);
  assert.deepEqual(f, { status: 200, ok: true }, 'it switches at once, with nothing to confirm');
  assert.ok(await until(() => A.latest()?.workspace.id === 'contract'));
  assert.equal((await api('/api/workspace/focus', { ws: 'default' }, A.client)).ok, true);
  const s = await until(() => { const l = A.latest(); return l?.workspace.id === 'default' && l.sessions.find((x) => x.sessionId === sid); });
  assert.deepEqual(s.queued.map((m) => m.text), ['after this, the tests'], 'the waiting message is still there');
  assert.equal((await api('/api/unqueue', { sessionId: sid, id: s.queued[0].id }, A.client)).ok, true);
});

test('a machine with no profile yet starts with one workspace on plain claude; a profile made later is a login, not a workspace', async (t) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-ws0-')), port = await freePort();
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
  assert.deepEqual(Object.keys(saved()?.workspaces ?? {}), ['default'], JSON.stringify(saved()));
  assert.equal(saved().logins.default.dir, path.join(h, '.claude'), 'its login is plain claude, signed in from here');
  assert.equal(fs.existsSync(path.join(h, '.claude')), false, 'nothing is made on disk until you sign in');
  fs.mkdirSync(path.join(h, '.claude-work'));
  fs.writeFileSync(path.join(h, '.claude-work', 'settings.json'), '{}');
  const s = await until(() => (saved()?.logins?.work ? saved() : null), 8000);
  assert.ok(s, `the new profile is a login: ${JSON.stringify(saved())} | ${out}`);
  assert.deepEqual(Object.keys(s.workspaces), ['default'], 'and not a workspace');
});

test('renaming a workspace shows in both pages\' snapshots', async () => {
  const before = B.latest().workspace;
  assert.equal((await api('/api/workspace/focus', { ws: 'contract' }, B.client)).ok, true);
  const r = await api('/api/workspace/update', { id: 'contract', name: 'Work', color: 'blue' }, B.client);
  assert.deepEqual(r, { status: 200, ok: true });
  assert.ok(await until(() => B.latest()?.workspace.name === 'Work' && B.latest().workspace.color === 'blue'), 'its own page sees it');
  assert.ok(await until(() => A.latest()?.workspaces.some((w) => w.id === 'contract' && w.name === 'Work' && w.color === 'blue')), 'the other page sees it in its switch');
  // Put it back, so the tests after this one meet the names they were written for.
  assert.equal((await api('/api/workspace/update', { id: 'contract', name: before.name, color: before.color }, B.client)).ok, true);
});

test('a page can rename or recolour the other workspace (Settings lists them all)', async () => {
  const before = A.latest().workspace;
  const r = await api('/api/workspace/update', { id: 'default', name: 'Mine now', color: 'rose' }, B.client);
  assert.deepEqual(r, { status: 200, ok: true });
  assert.ok(await until(() => A.latest()?.workspace.name === 'Mine now' && A.latest().workspace.color === 'rose'), 'the other workspace\'s page sees it');
  // Put it back, so the next test meets the name it was written for.
  assert.equal((await api('/api/workspace/update', { id: 'default', name: before.name, color: before.color }, B.client)).ok, true);
  assert.ok(await until(() => A.latest()?.workspace.name === before.name));
});

test('an invalid name or colour is refused with the store\'s error', async () => {
  const bad = async (body) => api('/api/workspace/update', { id: 'contract', ...body }, B.client);
  assert.deepEqual(await bad({ name: '   ' }), { status: 422, ok: false, error: 'A workspace needs a name.' });
  assert.equal((await bad({ name: 'x'.repeat(25) })).ok, false);
  assert.equal((await bad({ name: A.latest().workspace.name.toUpperCase() })).error, 'Another workspace has that name.');
  assert.equal((await bad({ name: 7 })).ok, false);
  assert.deepEqual(await bad({ color: 'amber' }), { status: 422, ok: false, error: 'Unknown colour.' });
  assert.equal((await api('/api/workspace/update', { id: 'nope', name: 'x' }, B.client)).ok, false);
});
