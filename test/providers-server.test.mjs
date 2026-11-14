// Workspaces and logins, end to end: logins made in Settings (a Claude profile, a Codex home) never make a workspace; a
// workspace uses several, one the default; sessions from every login it uses show in it, a session on a shared login
// lands by its repository and then its login's home; a launch runs on the login picked; a sign-in runs in the panel's
// own terminal; and OpenAI's Codex sign-in is read, given an API key on stdin, and signed out. Run with `npm test`.
// Starts the server on a spare port under a throwaway home, with stand-ins for claude and codex.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-prov-'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
const work = path.join(home, 'code', 'w'), side = path.join(home, 'code', 'side');
for (const d of [work, side]) fs.mkdirSync(d, { recursive: true });
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
const calls = path.join(home, 'claude-calls.log');
// claude: a roster per profile (roster-<folder>.json), nobody signed in, a sign-in that says which profile it ran on,
// and a launch that logs the profile it ran under.
fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), cfg = process.env.CLAUDE_CONFIG_DIR ?? null, at = cfg ? path.basename(cfg) : 'default';
if (a[0] === 'agents') { try { process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(home)}, 'roster-' + at + '.json'), 'utf8')); } catch { console.log('[]'); } process.exit(0); }
if (a[0] === 'auth' && a[1] === 'login') { console.log('SIGNIN ' + (cfg ?? 'unset')); process.exit(0); }
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: a, env: cfg }) + '\\n');
if (a[0] === '--bg') { console.log('backgrounded · 0badc0de'); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
// codex: its login is a file in CODEX_HOME, as Codex's own is.
fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), home = process.env.CODEX_HOME, f = home && path.join(home, 'auth.json');
if (a[0] === '--version') { console.log('codex-cli 0.169.0'); process.exit(0); }
if (a[0] === 'login' && a[1] === 'status') {
  if (f && fs.existsSync(f)) { console.error(fs.readFileSync(f, 'utf8') === 'chatgpt' ? 'Logged in using ChatGPT' : 'Logged in using an API key - sk-***'); process.exit(0); }
  console.error('Not logged in'); process.exit(1);
}
if (a[0] === 'login' && a[1] === '--with-api-key') {
  let d = '';
  process.stdin.on('data', (c) => { d += c; }).on('end', () => { fs.writeFileSync(f + '.key', d); fs.writeFileSync(f, 'apikey'); console.error('Successfully logged in'); });
  return;
}
if (a[0] === 'login') { console.log('CODEX LOGIN ' + home); fs.writeFileSync(f, 'chatgpt'); process.exit(0); }
if (a[0] === 'logout') { try { fs.unlinkSync(f); } catch {} console.log('Successfully logged out'); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });

const prefs = path.join(home, 'panel', 'prefs.json');
fs.mkdirSync(path.dirname(prefs));
fs.writeFileSync(prefs, JSON.stringify({ profile: 'default' }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ACP_') && k !== 'CODEX_HOME'));
const server = spawn(process.execPath, [SERVER], { env: { ...env, HOME: home, PATH: `${bin}:${env.PATH}`, ACP_PORT: String(PORT), ACP_PREFS: prefs, ACP_GITHUB: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { server.kill(); } catch {} });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start: ' + log)), 10_000);
  server.stdout.on('data', () => { if (log.includes(BASE)) { clearTimeout(t); resolve(); } });
  server.on('exit', () => reject(new Error('server exited: ' + log)));
});
const watcher = new AbortController();
after(async () => {
  watcher.abort();
  if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); });
  fs.rmSync(home, { recursive: true, force: true });
});
const token = (await (await fetch(BASE + '/')).text()).match(/[0-9a-f]{48}/)[0];
const CLIENT = 'page-one';
const post = (p, body, t = token) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': t, 'x-acp-client': CLIENT }, body: JSON.stringify(body ?? {}) });
const api = (p, body) => post(p, body).then((r) => r.json());
const settings = () => fetch(BASE + '/api/settings', { headers: { 'x-acp-token': token, 'x-acp-client': CLIENT } }).then((r) => r.json());
const loginOf = async (id) => (await settings()).logins.find((l) => l.id === id);

const named = [], frames = [];
fetch(`${BASE}/events?t=${token}&c=${CLIENT}`, { signal: watcher.signal }).then(async (r) => {
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString();
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = block.match(/^event: (.*)$/m)?.[1], data = block.match(/^data: (.*)$/m)?.[1];
      if (!data) continue;
      try { (ev ? named : frames).push(ev ? { ev, ...JSON.parse(data) } : JSON.parse(data)); } catch {}
    }
  }
}).catch(() => {});
async function until(fn, ms = 10_000, every = 50) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(every)) { const v = await fn(); if (v) return v; }
  return null;
}
const printed = (id) => named.filter((e) => e.ev === 'term' && e.sessionId === id).map((e) => Buffer.from(e.data, 'base64').toString()).join('');
const ended = (id) => named.some((e) => e.ev === 'term-exit' && e.sessionId === id);
const snap = () => frames.findLast((f) => Array.isArray(f?.sessions));
const shown = (sid) => snap()?.sessions.find((s) => s.sessionId === sid) ?? null;
const logged = () => { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const job = (sid, cwd) => ({ pid: null, id: sid.slice(0, 8), cwd, kind: 'background', startedAt: Date.now(), sessionId: sid, name: sid.slice(0, 4), status: 'idle', state: 'running' });
await until(() => snap());

test('a Claude login made in Settings is a new profile with live updates on, used by the workspace in view: no workspace is made', async () => {
  const r = await api('/api/login/create', { provider: 'claude', label: 'Second Max' });
  assert.deepEqual(r, { ok: true, id: 'second-max' }, log);
  const dir = path.join(home, '.claude-second-max');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).hooks).includes(`127.0.0.1:${PORT}/hook/`));
  const s = await settings();
  assert.deepEqual(s.workspaces.map((w) => w.id), ['default'], 'still one workspace');
  assert.deepEqual(s.workspaces[0].logins, ['default', 'second-max']);
  assert.equal(s.workspaces[0].defaults.claude, 'default', 'the first stays the default');
  const l = s.logins.find((x) => x.id === 'second-max');
  assert.deepEqual([l.provider, l.label, l.where, l.connected, l.users], ['claude', 'Second Max', '~/.claude-second-max', true, ['default']]);
  assert.ok(await until(() => JSON.stringify(snap()?.logins.map((x) => [x.id, x.isDefault])) === JSON.stringify([['default', true], ['second-max', false]])), 'the page sees both, the default first');
});

test('a login is refused without a name or with one taken; a folder already there is never used', async () => {
  assert.equal((await api('/api/login/create', { provider: 'claude', label: '  ' })).ok, false);
  assert.equal((await api('/api/login/create', { provider: 'claude', label: 'second max' })).ok, false);
  assert.equal((await api('/api/login/create', { provider: 'gemini', label: 'G' })).ok, false);
  fs.mkdirSync(path.join(home, '.claude-mine'));
  fs.writeFileSync(path.join(home, '.claude-mine', 'keep.txt'), 'mine');
  const r = await api('/api/login/create', { provider: 'claude', label: 'Mine' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await loginOf(r.id)).where, '~/.claude-mine-2', 'a new folder beside it');
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude-mine')), ['keep.txt'], 'the one there is untouched');
  assert.equal((await api('/api/login/remove', { id: r.id })).ok, true);
});

test('a workspace shows the sessions of every login it uses; a launch runs on the login picked, else the default', async () => {
  const S1 = 'a1a1a1a1-1111-4111-8111-111111111111', S2 = 'b2b2b2b2-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(home, 'roster-default.json'), JSON.stringify([job(S1, work)]));
  fs.writeFileSync(path.join(home, 'roster-.claude-second-max.json'), JSON.stringify([job(S2, work)]));
  assert.ok(await until(() => shown(S1) && shown(S2), 10_000), 'both rosters reach the one workspace: ' + JSON.stringify(snap()?.sessions));
  const from = logged().length;
  const launch = (extra) => api('/api/launch', { prompt: 'go', cwd: work, model: '', mode: 'default', ...extra });
  assert.equal((await launch({ login: 'second-max' })).ok, true);
  assert.equal((await launch({})).ok, true);
  assert.equal((await launch({ login: 'nope' })).ok, true, 'one it doesn’t use falls back to the default');
  assert.deepEqual(logged().slice(from).filter((c) => c.args[0] === '--bg').map((c) => c.env), [path.join(home, '.claude-second-max'), null, null]);
  // The launcher's look at a folder follows the login picked.
  assert.equal((await api('/api/folder', { path: work, login: 'second-max' })).profile, 'Second Max');
});

test('a login shared by two workspaces: its session lands in the workspace its repository is in, else its home', async () => {
  const made = await api('/api/workspace/create', { name: 'Side' });
  assert.deepEqual(made, { ok: true, id: 'side' });
  assert.deepEqual((await settings()).workspaces.find((w) => w.id === 'side').logins, ['default'], 'it starts on the default login of the workspace in view');
  assert.equal((await api('/api/login/attach', { ws: 'side', id: 'second-max' })).ok, true);
  assert.deepEqual((await loginOf('second-max')).users, ['default', 'side']);
  assert.equal((await api('/api/settings/assign', { key: `dir:${side}`, ws: ['side'] })).ok, true);
  const S3 = 'c3c3c3c3-3333-4333-8333-333333333333', S4 = 'd4d4d4d4-4444-4444-8444-444444444444';
  fs.writeFileSync(path.join(home, 'roster-.claude-second-max.json'), JSON.stringify([job(S3, side), job(S4, path.join(home, 'code'))]));
  assert.ok(await until(() => shown(S4)), 'an unsorted folder: its login’s home (the first workspace using it)');
  assert.equal(shown(S3), null, 'a repository in Side: not here');
  assert.equal((await api('/api/workspace/focus', { ws: 'side' })).ok, true);
  assert.ok(await until(() => shown(S3)), 'it is in Side');
  assert.equal(shown(S4), null);
  assert.equal((await api('/api/workspace/focus', { ws: 'default' })).ok, true);
  // Kept once placed: its repository sorted elsewhere later doesn't move it.
  assert.equal((await api('/api/settings/assign', { key: `dir:${side}`, ws: ['default'] })).ok, true);
  await pause(3500);
  assert.equal(shown(S3), null, 'S3 stays in Side');
});

test('a login with sessions running can’t be removed; removed, its folder stays and is not picked up again until shown', async () => {
  const running = await api('/api/login/remove', { id: 'second-max' });
  assert.equal(running.ok, false);
  assert.match(running.error, /still running on Second Max/);
  fs.writeFileSync(path.join(home, 'roster-.claude-second-max.json'), '[]');
  assert.ok(await until(async () => (await loginOf('second-max')).running === 0, 8000), 'its sessions ended');
  const r = await api('/api/login/remove', { id: 'second-max' });
  assert.deepEqual(r, { ok: true, dir: '~/.claude-second-max' });
  assert.ok(fs.existsSync(path.join(home, '.claude-second-max', 'settings.json')), 'its folder stays');
  await pause(3500); // a roster tick looks at the disk again
  assert.equal(await loginOf('second-max'), undefined, 'not picked up again');
  assert.equal((await settings()).hidden, 2, 'this one and Mine, removed before');
  assert.equal((await api('/api/login/unhide', {})).ok, true);
  assert.ok(await loginOf('second-max'), 'shown again, in no workspace');
  assert.deepEqual((await loginOf('second-max')).users, []);
});

test('a workspace can be removed (not the last); its logins stay', async () => {
  assert.equal((await api('/api/workspace/remove', { id: 'side' })).ok, true);
  assert.deepEqual((await settings()).workspaces.map((w) => w.id), ['default']);
  assert.ok(await loginOf('default'));
  assert.equal((await api('/api/workspace/remove', { id: 'default' })).ok, false);
});

test('Claude Code’s sign-in runs in the panel’s own terminal, on that login’s profile, for the page that opened it', async () => {
  assert.equal((await post('/api/login/term', { client: 'not-connected', login: 'default' }).then((r) => r.json())).ok, false);
  assert.equal((await api('/api/login/term', { client: CLIENT, login: 'nobody' })).ok, false);
  const r = await api('/api/login/term', { client: CLIENT, login: 'default', cols: 90, rows: 20 });
  assert.equal(r.ok, true, JSON.stringify(r) + log);
  assert.equal(r.id, 'login:default');
  assert.ok(await until(() => printed(r.id).includes('SIGNIN unset')), 'ran on plain claude: ' + printed(r.id));
  assert.ok(await until(() => ended(r.id)), 'it said it ended');
});

test('OpenAI: a login is a Codex home; an API key on stdin signs it in, and it signs out', async () => {
  const made = await api('/api/login/create', { provider: 'codex', label: 'OpenAI' });
  assert.deepEqual(made, { ok: true, id: 'openai' });
  assert.equal((await loginOf('openai')).where, '~/.codex', 'the first one is Codex’s own home');
  assert.equal((await settings()).workspaces[0].defaults.codex, 'openai');
  const c = await api('/api/codex', {});
  assert.deepEqual([c.installed, c.version], [true, '0.169.0']);
  assert.deepEqual(c.logins, [{ id: 'openai', state: 'signed-out', method: null, command: 'codex login' }]);
  assert.equal((await api('/api/codex/key', { login: 'openai', key: 'not a key' })).ok, false);
  assert.equal((await api('/api/codex/key', { login: 'default', key: 'sk-test-1234567890' })).ok, false, 'a Claude login is no Codex home');
  const k = await api('/api/codex/key', { login: 'openai', key: ' sk-test-1234567890 ' });
  assert.equal(k.ok, true, JSON.stringify(k) + log);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'auth.json.key'), 'utf8'), 'sk-test-1234567890\n', 'the key went on stdin');
  for (const f of fs.readdirSync(path.join(home, 'panel')).filter((n) => fs.statSync(path.join(home, 'panel', n)).isFile())) assert.ok(!fs.readFileSync(path.join(home, 'panel', f), 'utf8').includes('sk-test'), `Glue kept no copy (${f})`);
  assert.deepEqual((await api('/api/codex', {})).logins[0], { id: 'openai', state: 'ok', method: 'apikey', command: 'codex login' });
  assert.equal((await api('/api/codex/logout', { login: 'openai' })).ok, true);
  assert.equal((await api('/api/codex', {})).logins[0].state, 'signed-out');
  // A second one is a home of its own, and its ChatGPT sign-in runs in the panel's own terminal there.
  const two = await api('/api/login/create', { provider: 'codex', label: 'Work key' });
  assert.equal((await loginOf(two.id)).where, '~/.codex-work-key');
  const t = await api('/api/login/term', { client: CLIENT, login: two.id, cols: 90, rows: 20 });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.ok(await until(() => printed(t.id).includes('CODEX LOGIN ' + path.join(home, '.codex-work-key'))), printed(t.id));
  assert.ok(await until(() => ended(t.id)));
  const st = (await api('/api/codex', {})).logins.find((x) => x.id === two.id);
  assert.deepEqual([st.state, st.method, st.command], ['ok', 'chatgpt', 'CODEX_HOME=~/.codex-work-key codex login']);
});

test('the new routes need the token', async () => {
  for (const p of ['/api/login/create', '/api/login/remove', '/api/login/attach', '/api/login/detach', '/api/login/default', '/api/login/rename',
    '/api/login/unhide', '/api/workspace/create', '/api/workspace/remove', '/api/login/term', '/api/codex', '/api/codex/key', '/api/codex/logout', '/api/codex/install']) {
    assert.equal((await post(p, {}, 'nope')).status, 403, p);
  }
});
