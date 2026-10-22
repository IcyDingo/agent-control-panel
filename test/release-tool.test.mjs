import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { verifyRelease, signRelease } from '../release-keys.mjs';
import { keyDir, keyFiles, keygen, loadKey, sign, printed } from '../tools/release.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-')));
const run = (cmd, args, opts = {}) => new Promise((resolve) =>
  execFile(cmd, args, opts, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** A repo with two commits on main pushed to a bare origin, and a third commit that is not pushed. */
function repo() {
  const origin = tmp(), cwd = tmp();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com'); git(cwd, 'config', 'user.name', 'T');
  const commit = (msg) => { fs.writeFileSync(path.join(cwd, 'f'), msg); git(cwd, 'add', 'f'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
  const first = commit('one'), second = commit('two');
  git(cwd, 'remote', 'add', 'origin', origin); git(cwd, 'push', '-q', '-u', 'origin', 'main');
  const unpushed = commit('three');
  return { cwd, first, second, unpushed };
}

test('keygen writes an encrypted 0600 PEM under the next free name and prints a key that verifies', () => {
  const dir = path.join(tmp(), 'keys');
  const a = keygen({ dir, passphrase: 'pw' });
  assert.equal(a.file, path.join(dir, 'signing-key.pem'));
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(a.file, 'utf8'), /ENCRYPTED PRIVATE KEY/);
  const b = keygen({ dir, passphrase: 'pw2' });
  assert.equal(b.file, path.join(dir, 'signing-key-2.pem'), 'a second key gets a new file');
  assert.deepEqual(keyFiles(dir), [a.file, b.file]);
  const sha = 'c'.repeat(40);
  assert.equal(verifyRelease(1, sha, [signRelease(1, sha, loadKey(a.file, 'pw'))], [a.publicKey]), true);
  assert.throws(() => keygen({ dir, passphrase: '' }), /A passphrase is required/);
  assert.equal(keyFiles(dir).length, 2, 'the refused keygen wrote nothing');
});

test('a wrong passphrase or a key file that is not 0600 is refused', () => {
  const dir = path.join(tmp(), 'keys');
  const { file } = keygen({ dir, passphrase: 'pw' });
  assert.throws(() => loadKey(file, 'nope'), /did not open/);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadKey(file, 'pw'), /must be mode 0600/);
});

test('sign computes n from the commit count, signs with every key, and verifies under each', async () => {
  const dir = path.join(tmp(), 'keys');
  const a = keygen({ dir, passphrase: 'pw' }), b = keygen({ dir, passphrase: 'pw' });
  const { cwd, second } = repo();
  git(cwd, 'checkout', '-q', second); // a clean tree at a pushed commit
  const r = await sign({ sha: second, dir, passphrase: 'pw', cwd, run });
  assert.deepEqual([r.sha, r.n, r.sigs.length], [second, 2, 2]);
  assert.equal(verifyRelease(2, second, [r.sigs[0]], [a.publicKey]), true);
  assert.equal(verifyRelease(2, second, [r.sigs[1]], [b.publicKey]), true);
  assert.equal(verifyRelease(2, second, [r.sigs[0]], [b.publicKey]), false, 'each signature belongs to one key');
});

test('sign refuses a dirty tree, a sha not on origin/main, and a missing key', async () => {
  const dir = path.join(tmp(), 'keys');
  const { cwd, second, unpushed } = repo();
  await assert.rejects(sign({ sha: second, dir, passphrase: 'pw', cwd, run }), /No signing key/);
  keygen({ dir, passphrase: 'pw' });
  await assert.rejects(sign({ sha: unpushed, dir, passphrase: 'pw', cwd, run }), /is not on origin\/main/);
  fs.writeFileSync(path.join(cwd, 'f'), 'dirty');
  await assert.rejects(sign({ sha: second, dir, passphrase: 'pw', cwd, run }), /working tree has changes/);
});

test('the printed lines are the three settings and the ssh line', () => {
  const sha = 'd'.repeat(40);
  assert.deepEqual(printed({ sha, n: 7, sigs: ['s1', 's2'], host: 'root@hub.example' }), [
    `HUB_RELEASE=${sha}`, 'HUB_RELEASE_N=7', 'HUB_RELEASE_SIG=s1,s2',
    `ssh root@hub.example /srv/agent-hub/update.sh ${sha} 7 s1,s2`,
  ]);
  assert.equal(printed({ sha, n: 7, sigs: ['s1'], host: null })[3], `ssh <host> /srv/agent-hub/update.sh ${sha} 7 s1`);
});

test('the command line: keygen with the passphrase from the environment, then sign of HEAD, exit 0 and the lines on stdout', async () => {
  const home = tmp();
  const { cwd, second } = repo();
  git(cwd, 'checkout', '-q', second);
  const env = { ...process.env, HOME: home, ACP_SIGNING_KEY: path.join(home, 'keys'), ACP_SIGNING_PASSPHRASE: 'pw', ACP_RELEASE_HOST: 'root@hub.example' };
  delete env.ACP_HUB;
  const tool = path.resolve('tools/release.mjs');
  const gen = await run('node', [tool, 'keygen'], { env, cwd });
  assert.equal(gen.err, null, gen.stderr);
  assert.match(gen.stdout, /^Public key: [A-Za-z0-9+/]{43}=$/m);
  assert.match(gen.stdout, /Back the file up/);
  const s = await run('node', [tool, 'sign'], { env, cwd });
  assert.equal(s.err, null, s.stderr);
  const lines = s.stdout.trim().split('\n');
  assert.equal(lines[0], `HUB_RELEASE=${second}`);
  assert.equal(lines[1], 'HUB_RELEASE_N=2');
  assert.match(lines[2], /^HUB_RELEASE_SIG=[A-Za-z0-9_-]{86}$/);
  assert.equal(lines[3], `ssh root@hub.example /srv/agent-hub/update.sh ${second} 2 ${lines[2].slice('HUB_RELEASE_SIG='.length)}`);
  assert.doesNotMatch(s.stdout + gen.stdout, /PRIVATE KEY|pw/, 'nothing secret is printed');
  const noTty = await run('node', [tool, 'sign'], { env: { ...env, ACP_SIGNING_PASSPHRASE: '' }, cwd });
  assert.equal(noTty.err?.code, 1);
  assert.match(noTty.stderr, /No terminal to ask the passphrase on/);
});
