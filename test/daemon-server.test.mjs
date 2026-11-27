// The server as launchd runs it: ACP_DAEMON=1 waits for a taken port instead of exiting. Spawns real processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import { spawn } from 'node:child_process';

const SERVER = new URL('../server.mjs', import.meta.url).pathname;
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };
const answers = (port) => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false);
function start(port, prefsDir, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ACP_PORT: String(port), ACP_PREFS: path.join(prefsDir, 'prefs.json'), ACP_DAEMON: '1', ACP_GITHUB: 'off', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  // A child that already exited never emits 'exit' again, so stop resolves at once for it.
  const stop = () => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once('exit', r); child.kill(); });
  return { child, log: () => out, stop };
}

test('under ACP_DAEMON the server starts and serves the board', async (t) => {
  const port = await freePort(), prefs = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-'));
  const s = start(port, prefs); t.after(s.stop);
  assert.ok(await until(() => answers(port)), s.log());
  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(html, /Glue/);
  assert.doesNotMatch(html, /__ACP_TOKEN__/, 'the token placeholder was not filled in');
});

test('a taken port makes the daemon wait, not exit; it answers once the port frees up', async (t) => {
  const port = await freePort(), prefs = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-'));
  const holder = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => holder.once('listening', r));
  let held = true; // closed once, by the test or by t.after when an assertion fails first
  const free = () => (held ? (held = false, new Promise((r) => holder.close(r))) : Promise.resolve());
  t.after(free);
  const s = start(port, prefs, { ACP_RETRY_MS: '300' }); t.after(s.stop);
  assert.ok(await until(() => /port \d+ is taken/.test(s.log())), s.log());
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.child.exitCode, null, 'it exited: ' + s.log());
  await free();
  assert.ok(await until(() => answers(port)), s.log());
});

test('its log says when: each line has the time, and it says when it starts and why it stops', async () => {
  const port = await freePort(), prefs = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-'));
  const s = start(port, prefs);
  assert.ok(await until(() => answers(port)), s.log());
  await s.stop(); // SIGTERM, as launchd and the app stop it
  const lines = s.log().trim().split('\n');
  const T = String.raw`^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] `;
  assert.match(lines[0], new RegExp(`${T}Glue starting: pid ${s.child.pid}, node v[\\d.]+, port ${port}, background service$`));
  assert.ok(lines.some((l) => new RegExp(`${T}Glue → http://127.0.0.1:${port}$`).test(l)), s.log());
  assert.match(lines.at(-2), new RegExp(`${T}Glue got SIGTERM$`));
  assert.match(lines.at(-1), new RegExp(`${T}Glue stopped \\(exit code 0\\)$`));
});

test('a crash is logged with its time and stack, and exits 1', async () => {
  const port = await freePort(), prefs = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-'));
  // Not the daemon: a taken port is thrown, as a crash would be.
  const holder = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => holder.once('listening', r));
  const s = start(port, prefs, { ACP_DAEMON: '' });
  const code = await new Promise((r) => s.child.once('exit', r));
  holder.close();
  assert.equal(code, 1);
  assert.match(s.log(), /\] Glue crashed: Error: listen EADDRINUSE[^\n]*\n\s+at /);
  assert.match(s.log(), /\] Glue stopped \(exit code 1\)\n$/);
});

test('an argument runs the CLI instead of the server', async () => {
  const r = await new Promise((resolve) => { const c = spawn(process.execPath, [SERVER, 'nonsense'], { env: process.env }); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('exit', (code) => resolve({ code, out })); });
  assert.equal(r.code, 2);
  assert.match(r.out, /daemon install\|remove\|status/);
});
