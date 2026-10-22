import { test } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { verifyRelease, signRelease } from '../release-keys.mjs';
import { keyDir, keyFiles, keygen, loadKey, sign, printed, main } from '../tools/release.mjs';

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
  const PW = 'pw-' + crypto.randomUUID();
  const home = tmp();
  const { cwd, second } = repo();
  git(cwd, 'checkout', '-q', second);
  const env = { ...process.env, HOME: home, ACP_SIGNING_KEY: path.join(home, 'keys'), ACP_SIGNING_PASSPHRASE: PW, ACP_RELEASE_HOST: 'root@hub.example' };
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
  const printedOut = s.stdout + s.stderr + gen.stdout + gen.stderr;
  assert.doesNotMatch(printedOut, /PRIVATE KEY/, 'no key is printed');
  assert.equal(printedOut.includes(PW), false, 'the passphrase is not printed');
  const noTty = await run('node', [tool, 'sign'], { env: { ...env, ACP_SIGNING_PASSPHRASE: '' }, cwd });
  assert.equal(noTty.err?.code, 1);
  assert.match(noTty.stderr, /No terminal to ask the passphrase on/);
});

test('keyDir is ACP_SIGNING_KEY when set, else a folder under the home directory', () => {
  assert.equal(keyDir({ ACP_SIGNING_KEY: '/somewhere/keys' }), '/somewhere/keys');
  assert.equal(keyDir({}), path.join(os.homedir(), '.config', 'agent-panel'));
});

/** A main() with a fake run that answers git as a clean repo at a pushed commit and records every call. */
function fakeMain({ sshCode = null, status = '', fetch, files = true } = {}) {
  const dir = path.join(tmp(), 'keys');
  if (files) keygen({ dir, passphrase: 'pw' });
  const sha = 'a'.repeat(40), served = 'b'.repeat(40);
  const calls = [], out = [], err = [];
  const answers = {
    status: { stdout: status }, 'merge-base': {}, 'rev-list': { stdout: '5\n' }, 'rev-parse': { stdout: `${sha}\n` },
    'cat-file': {}, log: { stdout: 'a1b2c3d the newest\n' },
  };
  const fake = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'ssh') return { err: sshCode ? Object.assign(new Error('ssh'), { code: sshCode }) : null, stdout: '', stderr: '' };
    return { err: null, stdout: '', stderr: '', ...answers[args[0]] };
  };
  const go = (argv, extraEnv = {}) => main(argv, {
    env: { ACP_SIGNING_KEY: dir, ACP_SIGNING_PASSPHRASE: 'pw', ...extraEnv }, run: fake, fetch, cwd: '/the/repo',
    out: (l) => out.push(l), err: (l) => err.push(l),
  });
  return { go, calls, out, err, sha, served, dir };
}

test('--deploy splits user@host:dir on the first colon, runs ssh with inherited output, and returns its exit code', async () => {
  const t = fakeMain({ sshCode: 7 });
  assert.equal(await t.go(['sign', t.sha, '--deploy', 'root@hub.example:/opt/hub']), 7);
  const ssh = t.calls.find((c) => c.cmd === 'ssh');
  assert.deepEqual(ssh.args.slice(0, 3), ['--', 'root@hub.example', '/opt/hub/update.sh']);
  assert.deepEqual(ssh.args.slice(3, 5), [t.sha, '5']);
  assert.match(ssh.args[5], /^[A-Za-z0-9_-]{86}$/);
  assert.equal(ssh.opts.stdio, 'inherit');
  assert.equal(t.out[3], `ssh root@hub.example /opt/hub/update.sh ${t.sha} 5 ${ssh.args[5]}`);
  assert.ok(t.calls.filter((c) => c.cmd === 'git').every((c) => c.opts.cwd === '/the/repo'), 'every git call runs in cwd');

  const d = fakeMain();
  assert.equal(await d.go(['sign', d.sha, '--deploy', 'root@hub.example']), 0, 'ssh succeeded');
  assert.equal(d.calls.find((c) => c.cmd === 'ssh').args[2], '/srv/agent-hub/update.sh', 'the dir defaults');

  const e = fakeMain();
  assert.equal(await e.go(['sign', e.sha], { ACP_RELEASE_HOST: 'me@box:/x' }), 0);
  assert.ok(e.out[3].startsWith('ssh me@box /x/update.sh '), 'the environment host is split the same way');
  assert.equal(e.calls.some((c) => c.cmd === 'ssh'), false, 'without --deploy nothing is run on the server');
});

test('--deploy refuses an empty host, and puts -- before a host that looks like an option', async () => {
  for (const argv of [['--deploy', ':/opt/hub'], ['--deploy', ''], ['--deploy']]) {
    const t = fakeMain();
    assert.equal(await t.go(['sign', t.sha, ...argv]), 1);
    assert.match(t.err.join('\n'), /--deploy/);
    assert.equal(t.calls.some((c) => c.cmd === 'ssh'), false);
    assert.deepEqual(t.out, [], 'nothing is printed, nothing is signed');
  }
  const t = fakeMain();
  await t.go(['sign', t.sha, '--deploy', '-oProxyCommand=x']);
  assert.deepEqual(t.calls.find((c) => c.cmd === 'ssh').args.slice(0, 2), ['--', '-oProxyCommand=x']);
});

test('with ACP_HUB set the commits since the served release go to stderr and stdout stays four lines', async () => {
  const asked = [];
  const t = fakeMain({ fetch: async (url, opts) => { asked.push([url, opts]); return { json: async () => ({ ok: true, sha: 'b'.repeat(40) }) }; } });
  assert.equal(await t.go(['sign', t.sha], { ACP_HUB: 'https://hub.example/', ACP_RELEASE_HOST: 'root@h' }), 0);
  assert.equal(asked[0][0], 'https://hub.example/api/release');
  assert.ok(asked[0][1].signal, 'the request has a timeout');
  assert.equal(t.out.length, 4);
  assert.equal(t.err.join('\n'), `Since the release the hub serves (bbbbbbb):\na1b2c3d the newest`);
  const log = t.calls.find((c) => c.args[0] === 'log');
  assert.deepEqual(log.args, ['log', '--oneline', `${t.served}..${t.sha}`]);

  for (const fetch of [async () => { throw new Error('down'); }, async () => ({ json: async () => ({ ok: false }) })]) {
    const u = fakeMain({ fetch });
    assert.equal(await u.go(['sign', u.sha], { ACP_HUB: 'https://hub.example' }), 0);
    assert.deepEqual(u.err, [], 'an unreachable or unsigned hub is skipped silently');
    assert.equal(u.out.length, 4);
  }
});

test('keygen refuses two different passphrases and writes nothing; the same twice makes the key', async () => {
  const answers = ['one', 'two'];
  const t = fakeMain({ files: false });
  const run = (answerList) => main(['keygen'], {
    env: { ACP_SIGNING_KEY: t.dir }, ask: async () => answerList.shift(), out: (l) => t.out.push(l), err: (l) => t.err.push(l),
  });
  assert.equal(await run(answers), 1);
  assert.deepEqual(t.err, ['The passphrases differ.']);
  assert.deepEqual(keyFiles(t.dir), []);
  assert.equal(await run(['same', 'same']), 0);
  assert.equal(keyFiles(t.dir).length, 1);
  assert.match(t.out[0], /^Public key: /);
});

test('sign refuses an upper-case or short sha, and exits 1 without running ssh when it refuses', async () => {
  for (const sha of ['A'.repeat(40), 'abc1234']) {
    const t = fakeMain();
    assert.equal(await t.go(['sign', sha, '--deploy', 'root@h']), 1);
    assert.match(t.err.join('\n'), /full 40-character commit hash/);
    assert.equal(t.calls.length, 0, 'not even git is asked');
  }
  const dirty = fakeMain({ status: ' M f\n' });
  assert.equal(await dirty.go(['sign', dirty.sha, '--deploy', 'root@h']), 1);
  assert.match(dirty.err.join('\n'), /working tree has changes/);
  assert.equal(dirty.calls.some((c) => c.cmd === 'ssh'), false);
  assert.deepEqual(dirty.out, []);
  const none = fakeMain({ files: false });
  assert.equal(await none.go(['sign', none.sha]), 1);
  assert.match(none.err.join('\n'), /No signing key/);
  assert.equal(await none.go(['frobnicate']), 1);
});

test('the command line keeps the passphrase out of the environment of ssh and returns its exit code', async () => {
  const home = tmp(), bin = tmp(), report = path.join(tmp(), 'ssh-saw');
  const { cwd, second } = repo();
  git(cwd, 'checkout', '-q', second);
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nprintf \'%s\\n\' "${ACP_SIGNING_PASSPHRASE-unset}" "$@" > "$SSH_REPORT"\nexit 3\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SSH_REPORT: report, ACP_SIGNING_KEY: path.join(home, 'keys'), ACP_SIGNING_PASSPHRASE: 'pw' };
  delete env.ACP_HUB;
  const tool = path.resolve('tools/release.mjs');
  assert.equal((await run('node', [tool, 'keygen'], { env, cwd })).err, null);
  const s = await run('node', [tool, 'sign', '--deploy', 'root@hub.example:/opt/hub'], { env, cwd });
  assert.equal(s.err?.code, 3, s.stderr);
  const saw = fs.readFileSync(report, 'utf8').split('\n');
  assert.deepEqual(saw.slice(0, 4), ['unset', '--', 'root@hub.example', '/opt/hub/update.sh']);
});
