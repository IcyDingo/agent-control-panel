// Spaces, end to end: the real server on a throwaway home with two profiles (~/.claude and ~/.claude-contract), each a
// workspace. A space is made on one workspace's page, holds that workspace's sessions, and never reaches the other's.
// The harness is the one test/workspaces-server.test.mjs uses. Run with `npm test`. Starts the server on a spare port.
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
// A stopped background job too: removing it runs `claude rm`, which the stand-in refuses, as Claude Code does for a
// worktree with unsaved work.
const SID_S = 'aaaaaaaa-5555-4555-8555-555555555555';
fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', `${SID_S}.jsonl`), transcript('stopped work', work));
fs.writeFileSync(path.join(home, 'roster-default.json'), JSON.stringify([job(SID_D, 'default job', work), { ...job(SID_S, 'stopped job', work), status: null, state: 'stopped' }]));
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
// A space kept from an earlier run, whose member was last seen more than 14 days ago (the panel was off): the job is
// still on the roster, so the first roster read must keep it in its space.
fs.writeFileSync(path.join(home, 'panel', 'workspaces.json'), JSON.stringify({ v: 1,
  workspaces: { default: { name: 'claude', color: 'violet' }, contract: { name: 'claude-contract', color: 'blue' } }, order: ['contract', 'default'], repos: {}, focus: 'default',
  spaces: { default: { list: [{ id: 'kept0001', name: 'Kept' }], members: { [SID_D]: { space: 'kept0001', at: Date.now() - 15 * 86_400_000 } } } } }), { mode: 0o600 });
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

const repoS = path.join(home, 'code', 's');
fs.mkdirSync(path.join(repoS, '.git'), { recursive: true });
fs.writeFileSync(path.join(repoS, '.git', 'HEAD'), 'ref: refs/heads/main\n');
fs.writeFileSync(path.join(repoS, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:o/s.git\n');
const launchIn = (cwd, client, extra = {}) => api('/api/launch', { prompt: `work in ${client}`, cwd, model: '', mode: 'default', assign: ['default'], ...extra }, client);
const launchedBy = (client, from) => logged().slice(from).filter((x) => x.args[0] === '--bg' && x.args.at(-1) === `work in ${client}`);
const sessionIn = (pg, sid) => pg.latest()?.sessions.find((s) => s.sessionId === sid);

// Page B moves to contract; both pages wait until their own workspace's job is listed.
assert.equal((await api('/api/workspace/focus', { ws: 'contract' }, B.client)).ok, true);
await until(() => sessionIn(A, SID_D) && sessionIn(B, SID_C) && B.latest().workspace?.id === 'contract');

test('a member the roster still lists keeps its space after the panel was off for weeks', async () => {
  assert.ok(await until(() => sessionIn(A, SID_D)?.space === 'kept0001', 3000), JSON.stringify(sessionIn(A, SID_D)?.space ?? null));
  assert.deepEqual(A.latest().spaces.find((x) => x.id === 'kept0001'), { id: 'kept0001', name: 'Kept' });
});

test('a removal that is refused keeps the session in its space', async () => {
  const c = await api('/api/space/create', { name: 'Stopped ones' }, A.client);
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.ok(await until(() => sessionIn(A, SID_S)), 'the stopped job is listed');
  assert.equal((await api('/api/space/move', { sessionId: SID_S, space: c.id }, A.client)).ok, true);
  const r = await api('/api/remove', { sessionId: SID_S }, A.client);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(await until(() => sessionIn(A, SID_S)?.space === c.id, 2000), JSON.stringify(sessionIn(A, SID_S)?.space ?? null));
});

test('a space made on one page shows only in its own workspace', async () => {
  const r = await api('/api/space/create', { name: 'Billing bug' }, A.client);
  assert.equal(r.ok, true, JSON.stringify(r));
  const a = await until(() => A.latest()?.spaces?.some((x) => x.id === r.id) && A.latest());
  assert.ok(a, 'page A lists it');
  assert.deepEqual(a.spaces.find((x) => x.id === r.id), { id: r.id, name: 'Billing bug' });
  const b = await until(() => B.latest()?.spaces && B.latest());
  assert.deepEqual(b.spaces, []);
  assert.equal(JSON.stringify(B.latest()).includes('Billing bug'), false);
});

test('moving a session puts it in the space, and None takes it out', async () => {
  const c = await api('/api/space/create', { name: 'Moves' }, A.client), id = c.id;
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal((await api('/api/space/move', { sessionId: SID_D, space: id }, A.client)).ok, true);
  assert.ok(await until(() => sessionIn(A, SID_D)?.space === id), JSON.stringify(sessionIn(A, SID_D)?.space));
  assert.equal((await api('/api/space/move', { sessionId: SID_D, space: null }, A.client)).ok, true);
  assert.ok(await until(() => sessionIn(A, SID_D)?.space === null));
});

test('a page cannot move another workspace\'s session, or use its space', async () => {
  const mine = await api('/api/space/create', { name: 'Mine' }, A.client);
  const no = await api('/api/space/move', { sessionId: SID_C, space: mine.id }, A.client);
  assert.equal(no.ok, false);
  assert.equal(no.error, REFUSE);
  const theirs = await api('/api/space/create', { name: 'Contract work' }, B.client);
  assert.equal(theirs.ok, true, JSON.stringify(theirs));
  assert.equal((await api('/api/space/move', { sessionId: SID_D, space: theirs.id }, A.client)).error, 'No such space.');
  assert.equal((await api('/api/space/rename', { id: theirs.id, name: 'Taken' }, A.client)).error, 'No such space.');
  assert.equal((await api('/api/space/delete', { id: theirs.id }, A.client)).error, 'No such space.');
  assert.ok(await until(() => B.latest()?.spaces?.some((x) => x.id === theirs.id && x.name === 'Contract work')));
  assert.equal(sessionIn(B, SID_C)?.space ?? null, null);
});

test('a launch into a space lands there when the session appears', async () => {
  const c = await api('/api/space/create', { name: 'Launches' }, A.client), id = c.id;
  assert.equal(c.ok, true, JSON.stringify(c));
  const before = logged().length;
  const r = await launchIn(repoS, A.client, { space: id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(launchedBy(A.client, before).length, 1);
  // The stand-in says `backgrounded · deadbeef`; the roster then lists that job under its full id.
  const sid = 'deadbeef-9999-4999-8999-999999999999';
  const roster = JSON.parse(fs.readFileSync(path.join(home, 'roster-default.json'), 'utf8'));
  fs.writeFileSync(path.join(home, 'roster-default.json'), JSON.stringify([...roster, { pid: null, id: 'deadbeef', cwd: repoS, kind: 'background', startedAt: Date.now(), sessionId: sid, name: 'launched', status: 'idle', state: 'running' }]));
  assert.ok(await until(() => sessionIn(A, sid)?.space === id, 15_000), JSON.stringify(sessionIn(A, sid) ?? null));
});

test('a launch into a deleted space is refused and nothing runs', async () => {
  const c = await api('/api/space/create', { name: 'Gone soon' }, A.client), id = c.id;
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal((await api('/api/space/delete', { id }, A.client)).ok, true);
  const before = logged().length;
  const r = await launchIn(repoS, A.client, { space: id });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'That space is gone. Pick another.');
  assert.equal(launchedBy(A.client, before).length, 0);
});

test('deleting a space sends its sessions back', async () => {
  const c = await api('/api/space/create', { name: 'Short lived' }, A.client), id = c.id;
  assert.equal(c.ok, true, JSON.stringify(c));
  await api('/api/space/move', { sessionId: SID_D, space: id }, A.client);
  assert.ok(await until(() => sessionIn(A, SID_D)?.space === id));
  assert.equal((await api('/api/space/delete', { id }, A.client)).ok, true);
  assert.ok(await until(() => sessionIn(A, SID_D)?.space === null && !A.latest().spaces.some((x) => x.id === id)));
});
