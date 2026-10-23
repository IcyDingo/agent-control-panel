// update.sh in a temp /srv/agent-hub: `src` is a clone of a temp origin, `docker` and `curl` on PATH are fakes that
// record their arguments, `docker run … verify` answers from DOCKER_VERIFY (0 or 1) and `docker compose build` from
// DOCKER_BUILD. Hosts and ports are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-sh-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const SIG = 'x'.repeat(86);

function deploy({ keysFile = true } = {}) {
  const origin = tmp(), root = tmp(), bin = path.join(root, 'bin');
  git(origin, 'init', '-q', '-b', 'main'); git(origin, 'config', 'user.email', 't@example.com'); git(origin, 'config', 'user.name', 'T');
  const commit = (m) => { fs.writeFileSync(path.join(origin, 'f'), m); git(origin, 'add', 'f'); git(origin, 'commit', '-q', '-m', m); return git(origin, 'rev-parse', 'HEAD'); };
  const first = commit('one');
  git(root, 'clone', '-q', origin, 'src');
  const second = commit('two');
  if (keysFile) fs.writeFileSync(path.join(root, 'src', 'release-keys.mjs'), '// present\n');
  fs.copyFileSync('hub/deploy/update.sh', path.join(root, 'update.sh')); fs.chmodSync(path.join(root, 'update.sh'), 0o755);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' "docker $*" >> "$FAKE_LOG"\ncase "$1" in run) exit "${DOCKER_VERIFY:-0}";; esac\ncase "$1 $2" in "compose build") exit "${DOCKER_BUILD:-0}";; esac\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' "curl $*" >> "$FAKE_LOG"\nexit "${CURL_EXIT:-0}"\n', { mode: 0o755 });
  const log = path.join(root, 'calls.log');
  const run = (args, env = {}) => spawnSync(path.join(root, 'update.sh'), args, { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...env } });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const env = () => (fs.existsSync(path.join(root, 'release.env')) ? fs.readFileSync(path.join(root, 'release.env'), 'utf8') : null);
  const head = () => git(path.join(root, 'src'), 'rev-parse', 'HEAD');
  // What src knows of origin's main: it changes only when the script fetches.
  const fetched = () => git(path.join(root, 'src'), 'rev-parse', 'origin/main');
  const signedEnv = (sha, n) => fs.writeFileSync(path.join(root, 'release.env'), `HUB_RELEASE=${sha}\nHUB_RELEASE_N=${n}\nHUB_RELEASE_SIG=${SIG}\n`);
  return { root, first, second, run, calls, env, head, fetched, signedEnv };
}

test('plain mode still pulls main and writes HUB_RELEASE alone, until a signed release exists', () => {
  const d = deploy();
  const r = d.run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(d.env(), `HUB_RELEASE=${d.second}\n`);
  assert.equal(d.head(), d.second);
  assert.ok(d.calls().some((c) => c.startsWith('docker compose build')) && d.calls().some((c) => c.startsWith('curl')));
});

test('once a signed release is deployed, plain mode rebuilds and restarts it without a fetch, a checkout or a write', () => {
  const d = deploy();
  d.signedEnv(d.first, 1);
  const before = d.env();
  const r = d.run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(d.head(), d.first, 'no checkout');
  assert.equal(d.fetched(), d.first, 'no fetch');
  assert.equal(d.env(), before, 'release.env is not written');
  assert.equal(fs.existsSync(path.join(d.root, 'release.env.new')), false);
  const c = d.calls();
  assert.ok(c.includes('docker compose build -q') && c.includes('docker compose up -d'), c.join('\n'));
  assert.equal(c.filter((x) => x.startsWith('docker run')).length, 0, 'nothing to verify, nothing new is deployed');
  assert.ok(c.some((x) => x.includes('/healthz')) && c.some((x) => x.includes('/api/release')), 'both checks run');
  assert.ok(r.stdout.includes(`Restarted release ${d.first.slice(0, 7)} (number 1); to deploy a new one, run  node tools/release.mjs sign  on your Mac.`), r.stdout);
});

test('a restart is refused when src is not at the release on record, as after a signed build that failed', () => {
  const d = deploy();
  d.signedEnv(d.first, 1);
  assert.notEqual(d.run([d.second, '2', SIG], { DOCKER_BUILD: '1' }).status, 0);
  assert.equal(d.head(), d.second, 'the failed deploy left src on its commit');
  const r = d.run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`The checkout in src is not release ${d.first.slice(0, 7)}, the one on record; deploy with a signed line instead\\.`));
  assert.equal(d.calls().filter((c) => c === 'docker compose up -d').length, 0, 'nothing is started');
});

test('the same release again, same number and same sha, is verified and deployed once more', () => {
  const d = deploy();
  d.signedEnv(d.second, 2);
  const before = d.env();
  const r = d.run([d.second, '2', SIG]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(d.env(), before, 'release.env holds the same three lines');
  assert.equal(d.head(), d.second);
  assert.match(d.calls()[0], /^docker run .* verify /, 'the signature is still checked first');
  assert.ok(r.stdout.includes(`Deployed release ${d.second.slice(0, 7)} (number 2).`));
  const bad = d.run([d.second, '2', SIG], { DOCKER_VERIFY: '1' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /is not signed by a known key\./);
});

test('a build that fails leaves release.env as it was, so the same line can be run again', () => {
  const d = deploy();
  d.signedEnv(d.first, 1);
  const before = d.env();
  const r = d.run([d.second, '2', SIG], { DOCKER_BUILD: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(d.env(), before, 'the number on record is not used up');
  assert.equal(d.calls().includes('docker compose up -d'), false, 'nothing is started');
  const again = d.run([d.second, '2', SIG]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(d.env(), `HUB_RELEASE=${d.second}\nHUB_RELEASE_N=2\nHUB_RELEASE_SIG=${SIG}\n`);
  const fresh = deploy();
  assert.notEqual(fresh.run([], { DOCKER_BUILD: '1' }).status, 0);
  assert.equal(fresh.env(), null, 'a plain deploy whose build fails writes nothing either');
});

test('signed mode verifies before anything else, checks out the sha and writes the three lines', () => {
  const d = deploy();
  const r = d.run([d.second, '2', SIG]);
  assert.equal(r.status, 0, r.stderr);
  const c = d.calls();
  assert.match(c[0], new RegExp(`^docker run --rm --network none -v .*release-keys\\.mjs:/k\\.mjs:ro node:22-alpine node /k\\.mjs verify ${d.second} 2 ${SIG}$`));
  assert.equal(d.head(), d.second);
  assert.equal(d.env(), `HUB_RELEASE=${d.second}\nHUB_RELEASE_N=2\nHUB_RELEASE_SIG=${SIG}\n`);
  assert.ok(c.some((x) => x.includes('/api/release')), 'the release route is checked after the restart');
});

test('a bad signature, a bad argument, or a number that is not newer is refused before any fetch or write', () => {
  const d = deploy();
  const bad = d.run([d.second, '2', SIG], { DOCKER_VERIFY: '1' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, new RegExp(`Release ${d.second.slice(0, 7)} is not signed by a known key\\.`));
  assert.equal(d.head(), d.first, 'nothing checked out');
  assert.equal(d.env(), null, 'nothing written');
  assert.equal(d.calls().filter((c) => c.startsWith('docker compose')).length, 0);
  for (const args of [['abc', '2', SIG], [d.second, 'x', SIG], [d.second, '0', SIG], [d.second, '2', '']]) {
    const r = d.run(args);
    assert.equal(r.status, 1, args.join(' ')); assert.match(r.stderr, /is not valid\./);
  }
  assert.equal(d.run([d.second]).status, 2, 'one argument is a usage error');
  fs.writeFileSync(path.join(d.root, 'release.env'), `HUB_RELEASE=${d.first}\nHUB_RELEASE_N=2\nHUB_RELEASE_SIG=${SIG}\n`);
  const older = d.run([d.second, '2', SIG]);
  assert.equal(older.status, 1);
  assert.match(older.stderr, /\(number 2\) is not newer than the one deployed \(2\)\./);
  assert.equal(d.head(), d.first);
});

test('the bootstrap deploy, before release-keys.mjs exists, skips the verify step and still checks the hub afterwards', () => {
  const d = deploy({ keysFile: false });
  const r = d.run([d.second, '2', SIG], { CURL_EXIT: '22' });
  assert.equal(r.status, 1);
  assert.equal(d.calls().filter((c) => c.startsWith('docker run')).length, 0, 'no verify without the file');
  assert.match(r.stderr, /The hub refuses this release|healthz/);
});

test('an unreadable HUB_RELEASE_N is refused instead of lifting the floor', () => {
  for (const bad of ['2 ', 'two', '12345678901']) {
    const d = deploy();
    fs.writeFileSync(path.join(d.root, 'release.env'), `HUB_RELEASE=${d.first}\nHUB_RELEASE_N=${bad}\nHUB_RELEASE_SIG=${SIG}\n`);
    const r = d.run([d.second, '3', SIG]);
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.match(r.stderr, /release\.env has an unreadable HUB_RELEASE_N; fix it by hand before deploying\./);
    assert.equal(d.head(), d.first, 'nothing checked out');
    assert.equal(d.calls().length, 0, 'no docker or curl call');
  }
  const d = deploy();
  fs.writeFileSync(path.join(d.root, 'release.env'), `HUB_RELEASE=${d.first}\nHUB_RELEASE_N=\n`);
  assert.equal(d.run([d.second, '1', SIG]).status, 0, 'an empty value is no floor');
});

test('once release.env carries a signature, a missing release-keys.mjs is refused, not skipped', () => {
  const d = deploy({ keysFile: false });
  fs.writeFileSync(path.join(d.root, 'release.env'), `HUB_RELEASE=${d.first}\nHUB_RELEASE_N=2\nHUB_RELEASE_SIG=${SIG}\n`);
  const r = d.run([d.second, '3', SIG]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/release-keys\.mjs is missing; the checkout is damaged\./);
  assert.equal(d.head(), d.first, 'nothing checked out');
  assert.equal(d.calls().length, 0);
});

test('a deploy hands the database volume to the node user after the build and before the start, as root with CHOWN only', () => {
  const d = deploy();
  assert.equal(d.run([]).status, 0);
  const c = d.calls();
  const build = c.indexOf('docker compose build -q'), up = c.indexOf('docker compose up -d');
  const chown = c.findIndex((x) => x.startsWith('docker compose run --rm --no-deps -T --user root --cap-add CHOWN --entrypoint sh hub -c '));
  assert.ok(build !== -1 && build < chown && chown < up, c.join('\n'));
  assert.match(c[chown], /\|\| chown -R node:node \/data$/);
});

test('the script parses', () => { assert.equal(spawnSync('sh', ['-n', 'hub/deploy/update.sh']).status, 0); });
