// The worker's launcher, run with /bin/sh against a temp `worker/` folder whose path has a space in it. `node` is a stub
// that logs its arguments, so what the launcher would have run is seen, not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const A = '1'.repeat(40), B = '2'.repeat(40);
const LAUNCHER = path.join(import.meta.dirname, '..', 'launcher.sh');
const run = (runSh, env) => new Promise((resolve) =>
  execFile('/bin/sh', [runSh], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
    resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) })));

/** A worker folder with versions A and B, `current → A`, the launcher as run.sh, and a stub node. */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo rker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'worker');
  for (const sha of [A, B]) {
    fs.mkdirSync(path.join(dir, sha), { recursive: true });
    fs.writeFileSync(path.join(dir, sha, 'server.mjs'), '');
  }
  fs.symlinkSync(path.join(dir, A), path.join(dir, 'current'));
  const log = path.join(root, 'node.log');
  const node = path.join(root, 'node');
  fs.writeFileSync(node, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$STUB_LOG"\nexit 0\n', { mode: 0o755 });
  const runSh = path.join(dir, 'run.sh');
  fs.writeFileSync(runSh, fs.readFileSync(LAUNCHER, 'utf8').replace('__NODE__', node), { mode: 0o755 });
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  return { dir, log, runSh, read, go: () => run(runSh, { STUB_LOG: log }) };
}

test('with no switch the launcher runs current/server.mjs', async (t) => {
  const w = fixture(t);
  const r = await w.go();
  assert.equal(r.code, 0);
  const lines = fs.readFileSync(w.log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('/current/server.mjs'));
});

test('a switch whose version has started is removed', async (t) => {
  const w = fixture(t);
  fs.unlinkSync(path.join(w.dir, 'current'));
  fs.symlinkSync(path.join(w.dir, B), path.join(w.dir, 'current'));
  fs.writeFileSync(path.join(w.dir, 'switch'), `${B} ${A} 1\n`);
  fs.writeFileSync(path.join(w.dir, 'started'), B);
  const r = await w.go();
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(path.join(w.dir, 'switch')), false);
  assert.equal(fs.realpathSync(path.join(w.dir, 'current')), fs.realpathSync(path.join(w.dir, B)));
  assert.ok(fs.readFileSync(w.log, 'utf8').trim().endsWith('/current/server.mjs'));
});

test('a version that never starts is rolled back on the third try', async (t) => {
  const w = fixture(t);
  fs.unlinkSync(path.join(w.dir, 'current'));
  fs.symlinkSync(path.join(w.dir, B), path.join(w.dir, 'current'));
  fs.writeFileSync(path.join(w.dir, 'switch'), `${B} ${A} 2\n`);
  fs.writeFileSync(path.join(w.dir, 'started'), A);
  const r = await w.go();
  assert.equal(r.code, 0);
  assert.equal(fs.realpathSync(path.join(w.dir, 'current')), fs.realpathSync(path.join(w.dir, A)));
  assert.equal(fs.existsSync(path.join(w.dir, 'switch')), false);
  assert.ok(w.read('rolled-back').startsWith(`${B} 20`));
  assert.ok(fs.readFileSync(w.log, 'utf8').trim().endsWith('/current/server.mjs'));
});

test('an earlier try only counts up', async (t) => {
  const w = fixture(t);
  fs.unlinkSync(path.join(w.dir, 'current'));
  fs.symlinkSync(path.join(w.dir, B), path.join(w.dir, 'current'));
  fs.writeFileSync(path.join(w.dir, 'switch'), `${B} ${A} 0\n`);
  const r = await w.go();
  assert.equal(r.code, 0);
  assert.equal(w.read('switch'), `${B} ${A} 1\n`);
  assert.equal(fs.realpathSync(path.join(w.dir, 'current')), fs.realpathSync(path.join(w.dir, B)));
});

test('a missing current is a sentence and a non-zero exit, not an exec of nothing', async (t) => {
  const w = fixture(t);
  fs.unlinkSync(path.join(w.dir, 'current'));
  const r = await w.go();
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('worker/current is missing'));
  assert.equal(fs.existsSync(w.log), false);
});
