// The server as the Linux app runs it: on Electron's Node (ELECTRON_RUN_AS_NODE=1) from an installed folder
// (ACP_PACKAGED=1). Run with `npm test`. Starts the server from a copy of the tree, on a spare port, under a throwaway home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', '.github', '.claude', 'dist', 'test', 'docs', 'app', 'desktop']);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(50)) { const v = await fn(); if (v) return v; }
  return null;
}

/** A copy of the server's files in a folder of its own, a home with one profile, and a stand-in claude that notes
 *  the environment it was run in. */
async function start(t, extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-pkg-'));
  const tree = path.join(home, 'opt');
  fs.cpSync(REPO, tree, { recursive: true, filter: (src) => !SKIP.has(path.relative(REPO, src).split(path.sep)[0]) });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  const bin = path.join(home, 'bin'), seen = path.join(home, 'claude-env');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(seen)}, String(process.env.ELECTRON_RUN_AS_NODE ?? 'unset'));
console.log(process.argv[2] === 'agents' ? '[]' : '{}');
`, { mode: 0o755 });
  const prefs = path.join(home, 'panel', 'prefs.json');
  fs.mkdirSync(path.dirname(prefs));
  fs.writeFileSync(prefs, JSON.stringify({ profile: 'default' }));
  const port = 47900 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ACP_')));
  const server = spawn(process.execPath, [path.join(tree, 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, HOME: home, PATH: `${bin}:${env.PATH}`, ACP_PORT: String(port), ACP_PREFS: prefs, ACP_GITHUB: 'off', ...extra } });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); });
    // A stand-in claude the server started may still be writing its note: try again rather than fail on a folder
    // that filled while it was being emptied.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  assert.ok(await until(() => log.includes(base)), 'the server did not start: ' + log);
  const title = async () => (await (await fetch(base + '/')).text()).match(/<title>(.*?)<\/title>/)[1];
  const page = path.join(tree, 'public', 'index.html');
  const upgrade = () => fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('<title>Glue</title>', '<title>The next version</title>'));
  return { title, upgrade, seen, log: () => log };
}

test('the packaged app keeps serving the page it started with when an upgrade replaces the file under it', async (t) => {
  const s = await start(t, { ACP_PACKAGED: '1' });
  assert.equal(await s.title(), 'Glue');
  s.upgrade();
  assert.equal(await s.title(), 'Glue');
});

test('run from a checkout, an edit to the page shows on the next load', async (t) => {
  const s = await start(t, {});
  assert.equal(await s.title(), 'Glue');
  s.upgrade();
  assert.equal(await s.title(), 'The next version');
});

test("Electron's run-as-Node switch stops at the server: Claude Code never sees it", async (t) => {
  const s = await start(t, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(await until(() => fs.existsSync(s.seen) && fs.readFileSync(s.seen, 'utf8')), 'unset', s.log());
});
