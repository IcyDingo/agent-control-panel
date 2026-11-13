// The embedded terminal, end to end: the real server runs a stand-in `claude attach` in a pseudo-terminal (pty-bridge.py),
// its output comes on the page's stream as `term` events, keystrokes and sizes go back as POSTs, and the last page
// letting go hangs it up. Run with `npm test`. Starts the server on a spare port under a throwaway home.
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-term-'));
const BG = 'abcdef12-3456-4789-8abc-def012345678', BG8 = BG.slice(0, 8);
const TTY = '12345678-aaaa-4bbb-8ccc-dddddddddddd';
const SEND = 'fedcba98-7654-4321-8fed-cba987654321', SEND8 = SEND.slice(0, 8); // a background job with a process: it takes a message
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const work = path.join(home, 'work');
fs.mkdirSync(work);
fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');

// A background job up and idle, and a terminal session: only the first opens in the panel's terminal.
fs.writeFileSync(path.join(home, 'roster.json'), JSON.stringify([
  { pid: null, id: BG8, cwd: work, kind: 'background', startedAt: Date.now(), sessionId: BG, name: 'job', status: 'idle', state: 'running' },
  { pid: 99999, cwd: work, kind: 'interactive', startedAt: Date.now(), sessionId: TTY, name: 'tty', status: 'idle', state: 'running' },
  { pid: 99998, id: SEND8, cwd: work, kind: 'background', startedAt: Date.now(), sessionId: SEND, name: 'sender', status: 'idle', state: 'running' },
]));
// The saved conversation of the job that takes a message: `claude --resume` writes what it was sent there.
const sendLog = path.join(home, '.claude', 'projects', 'work', SEND + '.jsonl');
fs.mkdirSync(path.dirname(sendLog), { recursive: true });
fs.writeFileSync(sendLog, JSON.stringify({ type: 'user', message: { content: 'the first prompt' } }) + '\n');
// `claude attach <id>` stands in as a raw-mode program: it says hello with its size, echoes what it reads, says its
// new size on SIGWINCH, and leaves a mark when it is hung up.
const hup = path.join(home, 'hup');
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
// What the stand-in leaves behind when a terminal script runs it: the profile it was signed in on, the folder it ran in.
const loginMark = path.join(home, 'login-mark'), trustMark = path.join(home, 'trust-mark');
// The desktop's terminal, standing in: it runs what it is given, as a terminal would, with no window.
fs.writeFileSync(path.join(bin, 'xdg-terminal-exec'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'agents') { process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(home, 'roster.json'))}, 'utf8')); process.exit(0); }
if (a[0] === 'auth') {
  if (a[1] === 'login') fs.writeFileSync(${JSON.stringify(loginMark)}, String(process.env.CLAUDE_CONFIG_DIR ?? 'unset'));
  console.log('{}'); process.exit(0);
}
if (!a.length) { fs.writeFileSync(${JSON.stringify(trustMark)}, process.cwd()); process.exit(0); }
if (a[0] === '--resume') {
  // Claude Code takes a message for a running job only at a terminal: anything else and it refuses.
  if (!process.stdout.isTTY) { console.error('not a terminal'); process.exit(1); }
  fs.appendFileSync(${JSON.stringify(sendLog)}, JSON.stringify({ type: 'user', message: { content: a[3] }, size: process.stdout.columns + 'x' + process.stdout.rows }) + '\\n');
  setInterval(() => {}, 1000);
} else if (a[0] === 'attach') {
  process.stdin.setRawMode(true);
  process.stdout.write('ATTACHED ' + a[1] + ' ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');
  process.on('SIGWINCH', () => process.stdout.write('SIZE ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n'));
  process.on('SIGHUP', () => { fs.writeFileSync(${JSON.stringify(hup)}, 'hup'); process.exit(0); });
  process.stdin.on('data', (d) => process.stdout.write('GOT:' + JSON.stringify(String(d)) + '\\r\\n'));
  setInterval(() => {}, 1000);
} else process.exit(1);
`, { mode: 0o755 });

const prefs = path.join(home, 'panel', 'prefs.json');
fs.mkdirSync(path.dirname(prefs));
fs.writeFileSync(prefs, JSON.stringify({ profile: 'default' }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ACP_')));
const server = spawn(process.execPath, [SERVER], { env: { ...env, HOME: home, PATH: `${bin}:${env.PATH}`, ACP_PORT: String(PORT), ACP_PREFS: prefs,
  ACP_GITHUB: 'off', ACP_TERM_GRACE_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { server.kill(); } catch {} });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start: ' + log)), 10_000);
  server.stdout.on('data', () => { if (log.includes(BASE)) { clearTimeout(t); resolve(); } });
  server.on('exit', () => reject(new Error('server exited: ' + log)));
});
after(async () => {
  watcher.abort();
  if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); });
  fs.rmSync(home, { recursive: true, force: true });
});
const token = (await (await fetch(BASE + '/')).text()).match(/[0-9a-f]{48}/)[0];
const post = (p, body, t = token) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': t }, body: JSON.stringify(body ?? {}) });
const api = (p, body) => post(p, body).then((r) => r.json());

// A page watching, under its own client id: snapshots and named events, as they come.
const CLIENT = 'page-one';
const frames = [], named = [];
const watcher = new AbortController();
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
/** Everything the terminal printed so far, from its `term` events. */
const printed = () => named.filter((e) => e.ev === 'term' && e.sessionId === BG).map((e) => Buffer.from(e.data, 'base64').toString()).join('');
const board = () => frames.findLast((f) => Array.isArray(f?.sessions) && f.sessions.length >= 2);

test('a message for a running background job is handed to Claude Code at a terminal of its own', async () => {
  assert.ok(await until(() => board()?.sessions.some((x) => x.sessionId === SEND)), 'the roster reached the board: ' + log);
  const r = await api('/api/reply', { sessionId: SEND, text: 'carry on with the tests' });
  assert.deepEqual({ ok: r.ok, sent: r.sent }, { ok: true, sent: true }, JSON.stringify(r) + log);
  const got = fs.readFileSync(sendLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(got.message.content, 'carry on with the tests');
  // Off a Mac the terminal is pty-bridge.py's, which has a size. A Mac's is script(1)'s, which has none without a
  // terminal of its own to copy it from; Claude Code takes the message there all the same.
  if (process.platform !== 'darwin') assert.match(got.size, /^[1-9]\d*x[1-9]\d*$/, 'the terminal it ran in had no size');
});

// On a Mac both of these open Terminal.app for real, so they run only where the terminal is the stand-in above.
const MAC = process.platform === 'darwin' && 'a Mac opens Terminal.app itself';
test('off a Mac, signing in opens the desktop terminal on a script that runs claude auth login on the profile', { skip: MAC }, async () => {
  const r = await api('/api/setup/login', { what: 'claude' });
  assert.equal(r.ok, true, JSON.stringify(r) + log);
  assert.equal(await until(() => fs.existsSync(loginMark) && fs.readFileSync(loginMark, 'utf8')), 'unset', 'the plain profile: no CLAUDE_CONFIG_DIR');
});

test('off a Mac, trusting a folder opens the desktop terminal on Claude Code in that folder', { skip: MAC }, async () => {
  const r = await api('/api/trust-terminal', { path: work });
  assert.equal(r.ok, true, JSON.stringify(r) + log);
  assert.equal(await until(() => fs.existsSync(trustMark) && fs.readFileSync(trustMark, 'utf8')), fs.realpathSync(work));
});

test('a background job opens in the terminal; a terminal session does not', async () => {
  const snap = await until(board);
  assert.ok(snap, 'the roster reached the board: ' + log);
  assert.equal(snap.sessions.find((s) => s.sessionId === BG).termable, true);
  assert.equal(snap.sessions.find((s) => s.sessionId === TTY).termable, false);
  const r = await api('/api/term/open', { client: CLIENT, sessionId: TTY, cols: 80, rows: 24 });
  assert.equal(r.ok, false);
  assert.match(r.error, /background session/);
  const nobody = await api('/api/term/open', { client: 'not-connected', sessionId: BG, cols: 80, rows: 24 });
  assert.equal(nobody.ok, false);
});

test('it runs claude attach at the page size, prints on the stream, and takes keystrokes and a new size', async () => {
  const r = await api('/api/term/open', { client: CLIENT, sessionId: BG, cols: 101, rows: 33 });
  assert.equal(r.ok, true, r.error);
  assert.ok(await until(() => printed().includes(`ATTACHED ${BG8} 101x33`)), 'attached at the size asked: ' + printed());
  assert.equal((await api('/api/term/input', { client: CLIENT, sessionId: BG, data: 'hi\r' })).ok, true);
  assert.ok(await until(() => /GOT:"hi\\r"|GOT:"h"/.test(printed())), 'the keystrokes reached it: ' + printed());
  await api('/api/term/resize', { client: CLIENT, sessionId: BG, cols: 120, rows: 40 });
  assert.ok(await until(() => printed().includes('SIZE 120x40')), 'the new size reached it: ' + printed());
  // Another page that never opened it cannot type into it.
  assert.equal((await api('/api/term/input', { client: 'page-two', sessionId: BG, data: 'x' })).ok, false);
  // A page opening it again gets what it printed so far.
  const again = await api('/api/term/open', { client: CLIENT, sessionId: BG, cols: 120, rows: 40 });
  assert.match(Buffer.from(again.scrollback, 'base64').toString(), /ATTACHED/);
});

test('the last page letting go hangs it up after the grace', async () => {
  assert.equal((await api('/api/term/close', { client: CLIENT, sessionId: BG })).ok, true);
  assert.ok(await until(() => fs.existsSync(hup)), 'claude attach was hung up');
  assert.equal((await api('/api/term/input', { client: CLIENT, sessionId: BG, data: 'x' })).ok, false, 'closed');
});

test('the fonts come from the panel itself, and the page asks no other site for anything', async () => {
  for (const f of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2']) {
    const r = await fetch(`${BASE}/vendor/geist/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get('content-type'), 'font/woff2');
    assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), 'wOF2', f + ' is not a font file');
  }
  const html = await (await fetch(BASE + '/')).text();
  assert.doesNotMatch(html, /<(?:link|script)[^>]+(?:href|src)="https?:/, 'the page loads something from another site');
  for (const f of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2']) assert.ok(html.includes(`url("/vendor/geist/${f}")`), f + ' is not in the page');
});

test('the terminal routes need the token, and only the three library files are served', async () => {
  for (const p of ['/api/term/open', '/api/term/input', '/api/term/resize', '/api/term/close']) assert.equal((await post(p, { client: CLIENT, sessionId: BG }, 'nope')).status, 403);
  const js = await fetch(BASE + '/vendor/xterm/xterm.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  for (const p of ['/vendor/xterm/LICENSE', '/vendor/xterm/../../server.mjs', '/vendor/xterm/%2e%2e/%2e%2e/server.mjs']) {
    assert.notEqual((await fetch(BASE + p)).status, 200, p);
  }
});
