// Settings › Providers, end to end: a new Claude account made here becomes a workspace of its own, a sign-in runs in the
// panel's own terminal (Claude Code's on the workspace's profile, Codex's in its Codex home), and OpenAI's Codex sign-in
// is read, given an API key on stdin, and signed out. Run with `npm test`. Starts the server on a spare port under a
// throwaway home, with stand-ins for claude and codex.
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
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
// claude: an empty roster, nobody signed in, and a sign-in that says which profile it ran on.
fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === 'agents') { console.log('[]'); process.exit(0); }
if (a[0] === 'auth' && a[1] === 'login') { console.log('SIGNIN ' + (process.env.CLAUDE_CONFIG_DIR ?? 'unset')); process.exit(0); }
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }
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
const post = (p, body, t = token) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': t }, body: JSON.stringify(body ?? {}) });
const api = (p, body) => post(p, body).then((r) => r.json());
const settings = () => fetch(BASE + '/api/settings', { headers: { 'x-acp-token': token } }).then((r) => r.json());

const CLIENT = 'page-one';
const named = [];
fetch(`${BASE}/events?t=${token}&c=${CLIENT}`, { signal: watcher.signal }).then(async (r) => {
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString();
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = block.match(/^event: (.*)$/m)?.[1], data = block.match(/^data: (.*)$/m)?.[1];
      if (ev && data) try { named.push({ ev, ...JSON.parse(data) }); } catch {}
    }
  }
}).catch(() => {});
async function until(fn, ms = 10_000, every = 50) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(every)) { const v = await fn(); if (v) return v; }
  return null;
}
const printed = (id) => named.filter((e) => e.ev === 'term' && e.sessionId === id).map((e) => Buffer.from(e.data, 'base64').toString()).join('');
const ended = (id) => named.some((e) => e.ev === 'term-exit' && e.sessionId === id);
await pause(300); // the stream is open before a terminal is asked for

test('a new Claude account is made as a new profile and workspace, with live updates on', async () => {
  const r = await api('/api/profile/create', { name: 'Work Stuff' });
  assert.deepEqual(r, { ok: true, ws: 'work-stuff' }, log);
  const dir = path.join(home, '.claude-work-stuff');
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.ok(Object.keys(s.hooks).length > 0, 'its hooks point here');
  assert.ok(JSON.stringify(s.hooks).includes(`127.0.0.1:${PORT}/hook/`));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const w = (await settings()).workspaces.find((x) => x.id === 'work-stuff');
  assert.ok(w, 'it is a workspace');
  assert.equal(w.name, 'Work Stuff');
  assert.equal(w.connected, true);
});

test('a new account is refused for an empty name, a name taken, or a folder already there', async () => {
  assert.equal((await api('/api/profile/create', { name: '  ' })).ok, false);
  assert.match((await api('/api/profile/create', { name: 'work stuff' })).error, /name/);
  assert.equal((await api('/api/profile/create', { name: 'Default' })).ok, false, 'the plain profile’s id');
  fs.mkdirSync(path.join(home, '.claude-side'));
  const r = await api('/api/profile/create', { name: 'Side' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude-side')), [], 'an existing folder is left as it was');
  assert.equal((await api('/api/profile/create', { name: 'x'.repeat(25) })).ok, false);
});

test('Claude Code’s sign-in runs in the panel’s own terminal, on that workspace’s profile, for the page that opened it', async () => {
  assert.equal((await api('/api/login/term', { client: 'not-connected', what: 'claude', ws: 'work-stuff' })).ok, false);
  assert.equal((await api('/api/login/term', { client: CLIENT, what: 'claude', ws: 'nobody' })).ok, false);
  const r = await api('/api/login/term', { client: CLIENT, what: 'claude', ws: 'work-stuff', cols: 90, rows: 20 });
  assert.equal(r.ok, true, JSON.stringify(r) + log);
  assert.equal(r.id, 'login:claude:work-stuff');
  assert.ok(await until(() => printed(r.id).includes('SIGNIN ' + path.join(home, '.claude-work-stuff'))), 'ran on its profile: ' + printed(r.id));
  assert.ok(await until(() => ended(r.id)), 'it said it ended');
});

test('Codex: installed, each workspace signed out, then an API key on stdin signs one in, and it signs out', async () => {
  const c = await api('/api/codex', {});
  assert.equal(c.ok, true, log);
  assert.equal(c.installed, true);
  assert.equal(c.version, '0.169.0');
  assert.deepEqual(c.workspaces.map((w) => [w.id, w.state]).sort(), [['default', 'signed-out'], ['work-stuff', 'signed-out']]);
  assert.equal(c.workspaces.find((w) => w.id === 'work-stuff').command, 'CODEX_HOME=~/.codex-work-stuff codex login');

  assert.equal((await api('/api/codex/key', { ws: 'work-stuff', key: 'not a key' })).ok, false);
  const k = await api('/api/codex/key', { ws: 'work-stuff', key: ' sk-test-1234567890 ' });
  assert.equal(k.ok, true, JSON.stringify(k) + log);
  const codexHome = path.join(home, '.codex-work-stuff');
  assert.equal(fs.readFileSync(path.join(codexHome, 'auth.json.key'), 'utf8'), 'sk-test-1234567890\n', 'the key went on stdin');
  assert.ok(!fs.readFileSync(prefs, 'utf8').includes('sk-test'), 'Glue kept no copy');
  let st = (await api('/api/codex', {})).workspaces;
  assert.deepEqual(st.find((w) => w.id === 'work-stuff'), { id: 'work-stuff', state: 'ok', method: 'apikey', command: 'CODEX_HOME=~/.codex-work-stuff codex login' });
  assert.equal(st.find((w) => w.id === 'default').state, 'signed-out', 'another workspace’s Codex home is its own');

  assert.equal((await api('/api/codex/logout', { ws: 'work-stuff' })).ok, true);
  st = (await api('/api/codex', {})).workspaces;
  assert.equal(st.find((w) => w.id === 'work-stuff').state, 'signed-out');
});

test('Codex’s ChatGPT sign-in runs in the panel’s own terminal, in the workspace’s Codex home', async () => {
  const r = await api('/api/login/term', { client: CLIENT, what: 'codex', ws: 'default', cols: 90, rows: 20 });
  assert.equal(r.ok, true, JSON.stringify(r) + log);
  assert.ok(await until(() => printed(r.id).includes('CODEX LOGIN ' + path.join(home, '.codex'))), 'ran in ~/.codex: ' + printed(r.id));
  assert.ok(await until(() => ended(r.id)));
  const st = (await api('/api/codex', {})).workspaces.find((w) => w.id === 'default');
  assert.deepEqual([st.state, st.method], ['ok', 'chatgpt']);
});

test('the new routes need the token', async () => {
  for (const p of ['/api/profile/create', '/api/login/term', '/api/codex', '/api/codex/key', '/api/codex/logout', '/api/codex/install']) {
    assert.equal((await post(p, {}, 'nope')).status, 403, p);
  }
});
