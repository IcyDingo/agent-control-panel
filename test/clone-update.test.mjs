// A panel run from a git clone (./install.sh) learns that the hub has a newer release, and updates with one click: real
// git repositories in a temp folder (an origin, a clone that pushes to it, and the panel's own clone), and a fake hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { checkClone, updateClone } from '../clone-update.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clone-update-')));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const run = (cmd, args, opts = {}) => new Promise((resolve) =>
  execFile(cmd, args, opts, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })));
const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=T'];
const git = (dir, ...args) => execFileSync('git', [...ID, '-C', dir, ...args], { encoding: 'utf8' }).trim();

/** An origin with one commit on main, the panel's clone of it, and a second clone that publishes new commits. */
function repos() {
  const root = tmp(), origin = path.join(root, 'origin.git'), repo = path.join(root, 'panel'), dev = path.join(root, 'dev');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, dev]);
  git(dev, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dev, 'server.mjs'), 'one\n');
  git(dev, 'add', '.'); git(dev, 'commit', '-q', '-m', 'one'); git(dev, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, repo]);
  const publish = (text) => {
    fs.writeFileSync(path.join(dev, 'server.mjs'), text);
    git(dev, 'commit', '-q', '-am', text.trim()); git(dev, 'push', '-q', 'origin', 'main');
    return git(dev, 'rev-parse', 'HEAD');
  };
  return { repo, publish, head: () => git(repo, 'rev-parse', 'HEAD') };
}
/** A hub whose /api/release names `sha`. */
const hub = (sha) => async (url) => (url === 'https://hub.test/api/release' ? json({ ok: true, sha }) : json({ ok: false }, 404));
const check = (repo, sha) => checkClone({ repo, hubUrl: 'https://hub.test', fetch: hub(sha), run });

test('the hub naming the commit the clone runs is current', async () => {
  const { repo, head } = repos();
  assert.deepEqual(await check(repo, head()), { outcome: 'current' });
});

test('a release the clone already has in its history is current, not an update', async () => {
  const { repo, head, publish } = repos();
  const old = head();
  publish('two\n');
  await run('git', ['-C', repo, 'pull', '-q', '--ff-only']);
  assert.deepEqual(await check(repo, old), { outcome: 'current' });
});

test('a release the clone does not have is an update it can take', async () => {
  const { repo, head, publish } = repos();
  const was = head(), sha = publish('two\n');
  assert.deepEqual(await check(repo, sha), { outcome: 'available', sha, head: was, blocked: null });
});

test('an update is blocked, with the reason, on a branch other than main or with uncommitted edits', async () => {
  const { repo, publish } = repos();
  const sha = publish('two\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'mine\n'); // a file git doesn't track blocks nothing
  assert.equal((await check(repo, sha)).blocked, null);
  fs.writeFileSync(path.join(repo, 'server.mjs'), 'edited\n');
  assert.equal((await check(repo, sha)).blocked, "This folder has changes that aren't committed.");
  git(repo, 'checkout', '-q', '--', 'server.mjs');
  git(repo, 'checkout', '-q', '-b', 'mine');
  assert.equal((await check(repo, sha)).blocked, 'This folder is on the branch mine, not main.');
});

test('a hub that does not answer, or names no commit, is an error', async () => {
  const { repo } = repos();
  const down = async () => { throw new Error('offline'); };
  assert.equal((await checkClone({ repo, hubUrl: 'https://hub.test', fetch: down, run })).outcome, 'error');
  assert.deepEqual(await check(repo, 'nope'), { outcome: 'error', error: 'The hub named no release.' });
});

test('updating fast-forwards the clone to main and rebuilds the app', async () => {
  const { repo, head, publish } = repos();
  const sha = publish('two\n');
  fs.mkdirSync(path.join(repo, 'app'));
  fs.writeFileSync(path.join(repo, 'app', 'build.sh'), '#!/bin/sh\necho built > "$(dirname "$0")/built.txt"\n', { mode: 0o755 });
  const r = await updateClone({ repo, run });
  assert.deepEqual(r, { ok: true, sha, built: true });
  assert.equal(head(), sha);
  assert.equal(fs.readFileSync(path.join(repo, 'server.mjs'), 'utf8'), 'two\n');
  assert.ok(fs.existsSync(path.join(repo, 'app', 'built.txt')), 'app/build.sh ran');
});

test('the app is rebuilt where the running one lives, not only at the default place', async () => {
  const { repo, publish } = repos();
  publish('two\n');
  fs.mkdirSync(path.join(repo, 'app'));
  fs.writeFileSync(path.join(repo, 'app', 'build.sh'), '#!/bin/sh\necho "$AGENT_PANEL_APP" > "$(dirname "$0")/out.txt"\n', { mode: 0o755 });
  assert.equal((await updateClone({ repo, run, appPath: '/Users/x/Apps/Agent Panel.app' })).built, true);
  assert.equal(fs.readFileSync(path.join(repo, 'app', 'out.txt'), 'utf8'), '/Users/x/Apps/Agent Panel.app\n');
});

test('an app that does not build still leaves the new code in place, and says so', async () => {
  const { repo, publish } = repos();
  const sha = publish('two\n');
  fs.mkdirSync(path.join(repo, 'app'));
  fs.writeFileSync(path.join(repo, 'app', 'build.sh'), '#!/bin/sh\necho "no swiftc" >&2\nexit 1\n', { mode: 0o755 });
  const r = await updateClone({ repo, run });
  assert.equal(r.ok, true);
  assert.equal(r.sha, sha);
  assert.equal(r.built, false);
  assert.match(r.buildError, /no swiftc/);
});

test('updating refuses a blocked clone and one that cannot fast-forward, and changes nothing', async () => {
  const { repo, head, publish } = repos();
  publish('two\n');
  const was = head();
  fs.writeFileSync(path.join(repo, 'server.mjs'), 'edited\n');
  assert.deepEqual(await updateClone({ repo, run }), { ok: false, error: "This folder has changes that aren't committed." });
  assert.equal(head(), was);
  git(repo, 'checkout', '-q', '--', 'server.mjs');
  fs.writeFileSync(path.join(repo, 'local.txt'), 'x\n');
  git(repo, 'add', 'local.txt'); git(repo, 'commit', '-q', '-m', 'local');
  const mine = head(), r = await updateClone({ repo, run });
  assert.equal(r.ok, false);
  assert.match(r.error, /^git pull could not fast-forward/);
  assert.equal(head(), mine);
});
