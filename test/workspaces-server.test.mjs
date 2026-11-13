// Workspaces, end to end: the real server on a throwaway home with two profiles (~/.claude and ~/.claude-contract), each
// a workspace, both live at once. The stand-in `claude` reads the roster of the profile it runs under (from
// CLAUDE_CONFIG_DIR) and logs every other call with that variable, so a test can see which profile a process ran on.
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

// Where both sessions work, and a conversation for each in its own profile, so a reply has something to resume.
const work = path.join(home, 'code', 'w');
fs.mkdirSync(work, { recursive: true });
const transcript = (text) => [
  JSON.stringify({ type: 'user', cwd: work, permissionMode: 'default', timestamp: '2026-11-12T10:00:00.000Z', message: { role: 'user', content: text } }),
  JSON.stringify({ type: 'assistant', cwd: work, timestamp: '2026-11-12T10:00:01.000Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }] } }),
].join('\n') + '\n';
for (const [dir, sid] of [['.claude', SID_D], ['.claude-contract', SID_C]]) {
  fs.mkdirSync(path.join(home, dir, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, dir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(home, dir, 'projects', 'p', `${sid}.jsonl`), transcript(`work in ${dir}`));
}
// One background job per profile, up and idle with no process of its own: a reply resumes it with --bg.
const job = (sid, name) => ({ pid: null, id: sid.slice(0, 8), cwd: work, kind: 'background', startedAt: Date.now(), sessionId: sid, name, status: 'idle', state: 'running' });
fs.writeFileSync(path.join(home, 'roster-default.json'), JSON.stringify([job(SID_D, 'default job')]));
fs.writeFileSync(path.join(home, 'roster-.claude-contract.json'), JSON.stringify([job(SID_C, 'contract job')]));

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
const api = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': token }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

// A page watching, so permission requests are held at all. Frames arrive as they are sent.
const frames = [];
const page = new AbortController();
fetch(`${BASE}/events?t=${token}`, { signal: page.signal }).then(async (r) => {
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString();
    for (const m of buf.matchAll(/^data: (.*)$/gm)) { try { frames.push(JSON.parse(m[1])); } catch {} }
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
  }
}).catch(() => {});
async function until(fn, ms = 10_000, every = 100) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(every)) { const v = await fn(); if (v) return v; }
  return null;
}
const latest = () => frames.findLast((f) => Array.isArray(f?.sessions));
const logged = () => { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

after(async () => { page.abort(); if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); }); fs.rmSync(home, { recursive: true, force: true }); });

test('both workspaces\' sessions are live at once', async () => {
  const snap = await until(() => { const f = latest(); return [SID_D, SID_C].every((id) => f?.sessions.some((s) => s.sessionId === id && s.inRoster)) ? f : null; });
  assert.ok(snap, `both rosters are read: ${JSON.stringify(latest()?.sessions?.map((s) => [s.sessionId, s.ws]))} | ${log}`);
  assert.equal(snap.sessions.find((s) => s.sessionId === SID_D).ws, 'default');
  assert.equal(snap.sessions.find((s) => s.sessionId === SID_C).ws, 'contract');

  // A permission request from a contract session is held and listed, tagged with its workspace.
  const e = { session_id: SID_H, transcript_path: path.join(home, '.claude-contract', 'projects', 'p', `${SID_H}.jsonl`), cwd: work,
              hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo contract' }, permission_mode: 'default' };
  let answered = false;
  const held = fetch(BASE + '/hook/permission', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) })
    .then(async (r) => { answered = true; return r.text(); });
  const p = await until(() => latest()?.pending?.find((x) => x.sessionId === SID_H));
  assert.equal(answered, false, 'the request stays open');
  assert.ok(p, 'the request is listed');
  assert.equal(p.ws, 'contract');
  assert.equal(latest().sessions.find((s) => s.sessionId === SID_H)?.ws, 'contract');
  assert.equal((await api('/api/decide', { id: p.id, behavior: 'deny', message: 'not now' })).ok, true);
  assert.match(await held, /"behavior":"deny"/);
});

test('a reply runs under the session\'s own profile', async () => {
  const r = await api('/api/reply', { sessionId: SID_C, text: 'carry on, contract' });
  assert.equal(r.ok, true, JSON.stringify(r) + ' | ' + log);
  const c = logged().find((x) => x.args[0] === '--bg' && x.args.includes(SID_C));
  assert.ok(c, JSON.stringify(logged()));
  assert.deepEqual(c.args.slice(0, 3), ['--bg', '--resume', SID_C]);
  assert.ok(c.env?.endsWith('.claude-contract'), `ran under ${c.env}`);

  const d = await api('/api/reply', { sessionId: SID_D, text: 'carry on, default' });
  assert.equal(d.ok, true, JSON.stringify(d));
  const cd = logged().find((x) => x.args[0] === '--bg' && x.args.includes(SID_D));
  assert.ok(cd, JSON.stringify(logged()));
  assert.equal(cd.env, null, 'the plain profile runs with no CLAUDE_CONFIG_DIR');
});

test('a profile folder created after start becomes a workspace', async () => {
  fs.mkdirSync(path.join(home, '.claude-new', 'projects', 'p'), { recursive: true });
  const e = { session_id: SID_N, transcript_path: path.join(home, '.claude-new', 'projects', 'p', `${SID_N}.jsonl`), cwd: work,
              hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, permission_mode: 'default' };
  const r = await fetch(BASE + '/hook/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) });
  assert.equal(r.status, 200);
  // Within two roster ticks (3 s each).
  const snap = await until(() => { const f = latest(); return f?.sessions.some((s) => s.sessionId === SID_N) ? f : null; }, 7000);
  assert.ok(snap, 'the new profile\'s session shows up');
  assert.equal(snap.sessions.find((s) => s.sessionId === SID_N).ws, 'new');
  const wrong = frames.flatMap((f) => f?.sessions ?? []).filter((s) => s.sessionId === SID_N && s.ws !== 'new');
  assert.deepEqual(wrong, [], 'never put in another workspace');
});
