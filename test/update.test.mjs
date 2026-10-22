// The worker's own update: a temp `worker/` folder with a running version A and `current` pointing at it, a release
// archive built with the real tar, and a fake hub that names a release. `exit` is a spy, so a switch is seen, not done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { workerOf, markStarted, rolledBack, prune, checkForUpdate } from '../update.mjs';

const A = '1'.repeat(40), B = '2'.repeat(40);
// The only place a release is fetched from, whatever the hub's answer says.
const ARCHIVE = `https://codeload.github.com/IcyDingo/agent-control-panel/tar.gz/${B}`;
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-')));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const run = (cmd, args, opts = {}) => new Promise((resolve) =>
  execFile(cmd, args, opts, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })));

/** A worker folder running A: `<root>/worker/<A>/server.mjs` and `current → <A>`. */
function worker() {
  const dir = path.join(tmp(), 'worker');
  fs.mkdirSync(path.join(dir, A), { recursive: true });
  fs.writeFileSync(path.join(dir, A, 'server.mjs'), '');
  fs.symlinkSync(path.join(dir, A), path.join(dir, 'current'));
  return { dir, sha: A };
}

/** A .tar.gz whose single top folder is `top`, holding an empty server.mjs; COPYFILE_DISABLE keeps macOS's ._ files out. */
function archive(top) {
  const src = tmp();
  fs.mkdirSync(path.join(src, top));
  fs.writeFileSync(path.join(src, top, 'server.mjs'), '');
  const file = path.join(tmp(), 'archive.tgz');
  execFileSync('tar', ['-czf', file, '-C', src, top], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return fs.readFileSync(file);
}

/** A fake network: the hub's `/api/release` answers `release` (a Response, or a function that throws), GitHub's archive
 * address for B the bytes, and any other address (the hub's own `url` among them) a 404. Every call is recorded. */
function hub(release, bytes = null) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), redirect: init.redirect });
    if (String(url) === 'http://hub.test/api/release') return typeof release === 'function' ? release() : release;
    if (String(url) === ARCHIVE) return new Response(bytes);
    return json({ ok: false, error: 'Not found.' }, 404);
  };
  fn.calls = calls;
  return fn;
}
const names = (sha) => json({ ok: true, sha, url: 'http://hub.test/archive.tgz' });

function check(w, fetch) {
  const exits = [], logs = [];
  const result = checkForUpdate({ worker: w, hubUrl: 'http://hub.test', fetch, run, exit: (c) => exits.push(c), log: (m) => logs.push(m) });
  return result.then((r) => ({ ...r, exits, logs }));
}
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tgz') || n.endsWith('.tmp'));

test('workerOf recognises <…>/worker/<sha> through the current link and nothing else', () => {
  const { dir } = worker();
  fs.mkdirSync(path.join(dir, 'not-a-sha'));
  assert.deepEqual(workerOf(path.join(dir, 'current')), { dir, sha: A });
  assert.equal(workerOf(os.tmpdir()), null);
  assert.equal(workerOf(path.join(dir, 'not-a-sha')), null);
});

test('the same sha does nothing but prune', async () => {
  const w = worker();
  fs.mkdirSync(path.join(w.dir, '3'.repeat(40)));
  fs.mkdirSync(path.join(w.dir, `${B}.tmp`));
  const r = await check(w, hub(names(A)));
  assert.equal(r.outcome, 'current');
  assert.equal(fs.existsSync(path.join(w.dir, '3'.repeat(40))), false);
  assert.deepEqual(leftovers(w.dir), []);
  assert.equal(fs.readlinkSync(path.join(w.dir, 'current')), path.join(w.dir, A));
  assert.equal(fs.existsSync(path.join(w.dir, A, 'server.mjs')), true);
  assert.deepEqual(r.exits, []);
});

test('a new sha is downloaded, verified, switched and the process asked to exit', async () => {
  const w = worker();
  const r = await check(w, hub(names(B), archive(`agent-control-panel-${B}`)));
  assert.equal(r.outcome, 'switched');
  assert.ok(fs.readlinkSync(path.join(w.dir, 'current')).endsWith(B));
  assert.equal(fs.existsSync(path.join(w.dir, B, 'server.mjs')), true);
  assert.equal(fs.existsSync(path.join(w.dir, A, 'server.mjs')), true); // the launcher rolls back to it if B fails to start
  assert.equal(fs.readFileSync(path.join(w.dir, 'switch'), 'utf8'), `${B} ${A} 0\n`);
  assert.deepEqual(r.exits, [0]);
  assert.deepEqual(leftovers(w.dir), []);
});

test("the release is fetched from GitHub's archive for that commit, never from the address the hub gives", async () => {
  const w = worker();
  const fetch = hub(json({ ok: true, sha: B, url: 'http://elsewhere.test/archive.tgz' }), archive(`agent-control-panel-${B}`));
  const r = await check(w, fetch);
  assert.equal(r.outcome, 'switched');
  assert.equal(fetch.calls.some((c) => c.url.startsWith('http://elsewhere.test')), false);
  assert.deepEqual(fetch.calls.find((c) => c.url === ARCHIVE), { url: ARCHIVE, redirect: 'error' });
});

test('a release the launcher rolled back is held, not tried again', async () => {
  const w = worker();
  fs.writeFileSync(path.join(w.dir, 'rolled-back'), `${B} 2026-10-22T10:00:00Z\n`);
  const fetch = hub(names(B), archive(`agent-control-panel-${B}`));
  const r = await check(w, fetch);
  assert.equal(r.outcome, 'held');
  assert.equal(r.sha, B);
  assert.deepEqual(fetch.calls.map((c) => c.url), ['http://hub.test/api/release']);
  assert.equal(fs.readlinkSync(path.join(w.dir, 'current')), path.join(w.dir, A));
  assert.equal(fs.existsSync(path.join(w.dir, B)), false);
  assert.equal(fs.existsSync(path.join(w.dir, 'switch')), false);
  assert.deepEqual([...r.exits, ...r.logs], []);
});

test('prune keeps every version switch and rolled-back name, and removes the rest', () => {
  const w = worker();
  const [C, D, E, F] = ['3', '4', '5', '6'].map((c) => c.repeat(40));
  for (const sha of [C, D, E, F]) fs.mkdirSync(path.join(w.dir, sha));
  fs.writeFileSync(path.join(w.dir, 'switch'), `${C} ${D} 1\n`);
  fs.writeFileSync(path.join(w.dir, 'rolled-back'), `${E} 2026-10-22T10:00:00Z\n`);
  prune(w);
  for (const sha of [A, C, D, E]) assert.equal(fs.existsSync(path.join(w.dir, sha)), true, sha);
  assert.equal(fs.existsSync(path.join(w.dir, F)), false);
});

test('an archive with the wrong top folder is discarded and nothing changes', async () => {
  const w = worker();
  const r = await check(w, hub(names(B), archive('agent-control-panel-main')));
  assert.equal(r.outcome, 'error');
  assert.equal(fs.readlinkSync(path.join(w.dir, 'current')), path.join(w.dir, A));
  assert.equal(fs.existsSync(path.join(w.dir, B)), false);
  assert.equal(fs.existsSync(path.join(w.dir, 'switch')), false);
  assert.deepEqual(leftovers(w.dir), []);
  assert.deepEqual(r.exits, []);
});

test('a hub that answers no release, or an unreachable one, is an error and nothing changes', async () => {
  const w = worker();
  const none = await check(w, hub(json({ ok: false, error: 'No release is published yet.' }, 503)));
  assert.equal(none.outcome, 'error');
  const down = await check(w, hub(() => { throw new TypeError('fetch failed'); }));
  assert.equal(down.outcome, 'error');
  assert.equal(fs.readlinkSync(path.join(w.dir, 'current')), path.join(w.dir, A));
  assert.equal(fs.existsSync(path.join(w.dir, 'switch')), false);
  assert.deepEqual([...none.exits, ...down.exits], []);
});

test('{ "auto": false } never asks the hub', async () => {
  const w = worker();
  fs.writeFileSync(path.join(w.dir, 'update.json'), '{ "auto": false }\n');
  const fetch = hub(names(B));
  const r = await check(w, fetch);
  assert.equal(r.outcome, 'off');
  assert.equal(fetch.calls.length, 0);
});

test('markStarted and rolledBack read and write their one-line files', () => {
  const w = worker();
  markStarted(w);
  assert.equal(fs.readFileSync(path.join(w.dir, 'started'), 'utf8'), A + '\n');
  assert.equal(rolledBack(w.dir), null);
  fs.writeFileSync(path.join(w.dir, 'rolled-back'), `${B} 2026-10-22T10:00:00Z\n`);
  assert.deepEqual(rolledBack(w.dir), { sha: B, at: '2026-10-22T10:00:00Z' });
});
