// The worker's install script, run with /bin/sh against a temp HOME whose path has a space in it. `node`, `curl`,
// `xcode-select` and `claude` are stubs first on PATH, so what the script would have run is seen, not run; `uname`,
// `sw_vers`, `tar` and `sed` are the real ones. The release archive is a real tarball of a fake release folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

const SHA = 'abcdef0123'.repeat(4);
const SCRIPT = path.join(import.meta.dirname, '..', 'hub', 'public', 'install.sh');
const LAUNCHER = path.join(import.meta.dirname, '..', 'launcher.sh');
const RELEASE = JSON.stringify({ ok: true, sha: SHA, url: `https://codeload.github.com/IcyDingo/agent-control-panel/tar.gz/${SHA}` });
const sh = (...lines) => ['#!/bin/sh', ...lines, ''].join('\n');

const STUBS = {
  node: sh(
    'echo "$*" >> "$STUB_LOG"',
    'case "$*" in',
    '  "-p process.versions.node") echo "${STUB_NODE_VERSION:-22.1.0}" ;;',
    '  *"daemon install"*)',
    '    prog=; prev=',
    '    for a in "$@"; do [ "$prev" = --program ] && prog="$a"; prev="$a"; done',
    '    mkdir -p "$HOME/Library/LaunchAgents"',
    '    echo "$prog" > "$HOME/Library/LaunchAgents/local.agent-panel.plist"',
    '    echo "Background service local.agent-panel installed" ;;',
    '  *"daemon remove") echo "Background service removed" ;;',
    '  *login*) [ -n "${STUB_LOGIN_FAILS:-}" ] && exit 1; echo "Linked to @ada." ;;',
    'esac'),
  curl: sh(
    'out=; url=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac',
    '  shift',
    'done',
    'case "$url" in',
    '  *127.0.0.1:4747*) exit "${STUB_READY:-0}" ;;',
    '  */api/release) echo "$STUB_RELEASE"; exit 0 ;;',
    'esac',
    '[ -n "$out" ] && cp "$STUB_ARCHIVE" "$out"'),
  'xcode-select': sh('echo /Library/Developer/CommandLineTools', 'exit "${STUB_XCODE:-0}"'),
  claude: sh('echo "2.1.310 (Claude Code)"'),
  // The wait for the service is twenty half-second sleeps; a sleep that returns at once keeps that test quick.
  sleep: sh('exit 0'),
};

/** A temp HOME, the stubs (all of them unless `without` names one), and the release archive (with its launcher.sh
 * unless `launcher` is false). */
function fixture(t, { without = [], launcher = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'in stall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'ho me');
  const stubs = path.join(root, 'stubs');
  fs.mkdirSync(home);
  fs.mkdirSync(stubs);
  for (const [name, body] of Object.entries(STUBS)) {
    if (!without.includes(name)) fs.writeFileSync(path.join(stubs, name), body, { mode: 0o755 });
  }
  const release = path.join(root, 'src', `agent-control-panel-${SHA}`);
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, 'server.mjs'), '');
  if (launcher) fs.copyFileSync(LAUNCHER, path.join(release, 'launcher.sh'));
  const archive = path.join(root, 'release.tgz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'src'), `agent-control-panel-${SHA}`],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const log = path.join(root, 'node.log');
  const dir = path.join(home, 'Library', 'Application Support', 'Agent Panel', 'worker');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'local.agent-panel.plist');
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const go = (args = [], env = {}) => new Promise((resolve) =>
    execFile('/bin/sh', [SCRIPT, ...args], {
      env: { PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, STUB_LOG: log, STUB_ARCHIVE: archive,
        STUB_RELEASE: RELEASE, ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) })));
  return { root, home, stubs, dir, plist, lines, go };
}

test('without node it stops with the nodejs.org sentence', async (t) => {
  const f = fixture(t, { without: ['node'] });
  const r = await f.go();
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes('Install Node from nodejs.org (the LTS installer), then run the line again.'));
  assert.equal(fs.existsSync(f.dir), false);
});

test('it installs the release into worker/<sha>, writes the launcher, installs the service through it and links', async (t) => {
  const f = fixture(t);
  const r = await f.go(['--link', 'dc-xyz']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(f.dir, SHA, 'server.mjs')));
  assert.ok(fs.readlinkSync(path.join(f.dir, 'current')).endsWith(`/${SHA}`));
  const runSh = path.join(f.dir, 'run.sh');
  const launcher = fs.readFileSync(runSh, 'utf8');
  assert.ok(launcher.includes(path.join(f.stubs, 'node')));
  assert.ok(!launcher.includes('__NODE__'));
  assert.ok(fs.statSync(runSh).mode & 0o111);
  const left = fs.readdirSync(f.dir);
  assert.ok(!left.includes(`${SHA}.tgz`) && !left.includes(`${SHA}.tmp`), left.join(' '));
  assert.ok(f.lines().some((l) => /daemon install --program .*\/worker\/run\.sh$/.test(l)));
  assert.ok(f.lines().some((l) => l.endsWith('login --link dc-xyz')));
  assert.ok(fs.existsSync(f.plist));
  assert.ok(r.stdout.includes('Linked to @ada.'));
});

test('a link code that starts with a dash is still a code, and is passed through', async (t) => {
  const f = fixture(t);
  const r = await f.go(['--link', '-abc']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(f.lines().some((l) => l.endsWith('login --link -abc')));
});

test('the closing lines say how to sign out before removing, and offer the turn-off line only when updates are on', async (t) => {
  const f = fixture(t);
  const on = await f.go();
  assert.equal(on.code, 0, on.stdout + on.stderr);
  assert.ok(on.stdout.includes(`To remove the worker (sign out first with  node "${f.dir}/current/server.mjs" logout  so the hub forgets this Mac):`));
  assert.ok(on.stdout.includes(`to turn that off:   printf '{ "auto": false }\\n' > "${f.dir}/update.json"`));
  assert.ok(!on.stdout.includes('To remove everything'));
  const off = await f.go(['--no-update']);
  assert.equal(off.code, 0, off.stdout + off.stderr);
  assert.ok(!off.stdout.includes('to turn that off'));
  assert.ok(off.stdout.includes('To remove the worker'));
});

test('without a link it signs in the usual way', async (t) => {
  const f = fixture(t);
  const r = await f.go();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(f.lines().some((l) => l.endsWith(' login')));
});

test('missing Command Line Tools is a sentence, not a stop', async (t) => {
  const f = fixture(t);
  const r = await f.go([], { STUB_XCODE: '1' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("Commits won't count until you run  xcode-select --install"));
});

test('--no-update writes update.json', async (t) => {
  const f = fixture(t);
  const r = await f.go(['--no-update']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, 'update.json'), 'utf8'), '{ "auto": false }\n');
});

test('a service from another folder is taken over, and says so', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.plist), { recursive: true });
  fs.writeFileSync(f.plist, '<string>/Users/x/agent-control-panel/server.mjs</string>\n');
  const r = await f.go();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('A background service already runs from another folder'));
  assert.ok(r.stdout.indexOf('another folder') > r.stdout.indexOf('Background service local.agent-panel installed'));
});

test('when the service does not answer it says where the log is and still signs in', async (t) => {
  const f = fixture(t);
  const r = await f.go([], { STUB_READY: '1' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('daemon-4747.log'));
  assert.ok(f.lines().some((l) => l.endsWith(' login')));
});

test('a release the script cannot read is a stop', async (t) => {
  const f = fixture(t);
  const r = await f.go([], { STUB_RELEASE: '{"ok":false,"error":"This hub does not name a release yet."}' });
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes('The hub did not name a release'));
});

test('--uninstall removes the service and the folder and lists what is left', async (t) => {
  const f = fixture(t);
  assert.equal((await f.go(['--link', 'dc-xyz'])).code, 0);
  const r = await f.go(['--uninstall']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(f.dir), false);
  assert.ok(f.lines().some((l) => l.includes('daemon remove')));
  assert.ok(r.stdout.includes('hub.json'));
  assert.ok(r.stdout.includes('Logs/Agent Panel'));
});

test('--uninstall leaves a service that runs from elsewhere in place, and says so', async (t) => {
  const f = fixture(t);
  assert.equal((await f.go()).code, 0);
  fs.writeFileSync(f.plist, '<string>/Users/x/agent-control-panel/server.mjs</string>\n');
  const r = await f.go(['--uninstall']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(f.lines().some((l) => l.includes('daemon remove')), false);
  assert.ok(r.stdout.includes("The background service runs from elsewhere (the app's install); it was left in place."));
  assert.ok(fs.existsSync(f.plist), 'the app\'s service is left alone');
  assert.equal(fs.existsSync(f.dir), false, 'the worker is still removed');
});

test('an archive that is not the release is a stop that leaves nothing behind', async (t) => {
  const f = fixture(t);
  const html = path.join(f.root, 'page.html');
  fs.writeFileSync(html, '<!doctype html><title>Not found</title>\n');
  const r = await f.go([], { STUB_ARCHIVE: html });
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes('The archive did not look like the release.'));
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('a download cut short is a stop, even when tar made the top folder before it failed', async (t) => {
  const f = fixture(t);
  const cut = path.join(f.root, 'cut.tgz');
  // Uncompressed, so the folder's header comes first and the cut lands in the files after it.
  const big = path.join(f.root, 'src', `agent-control-panel-${SHA}`, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(64 * 1024, 7));
  execFileSync('tar', ['-cf', cut, '-C', path.join(f.root, 'src'), `agent-control-panel-${SHA}`],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  fs.truncateSync(cut, 1536);
  const r = await f.go([], { STUB_ARCHIVE: cut });
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes('The archive did not look like the release.'));
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('a release without launcher.sh is a stop, and nothing is switched to it', async (t) => {
  const f = fixture(t, { launcher: false });
  const r = await f.go();
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes('The archive did not look like the release.'));
  assert.deepEqual(fs.readdirSync(f.dir), []);
  assert.equal(f.lines().some((l) => l.includes('daemon install')), false);
});

test('an unknown flag or a --link without a code prints the usage and exits 2', async (t) => {
  const f = fixture(t);
  for (const args of [['--bogus'], ['--link'], ['--link', ''], ['--link', '--no-update']]) {
    const r = await f.go(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.stderr.startsWith('usage: '), args.join(' '));
  }
  assert.equal(fs.existsSync(f.dir), false);
});

test('a sign-in that fails is a stop with a sentence', async (t) => {
  const f = fixture(t);
  const r = await f.go(['--link', 'dc-old'], { STUB_LOGIN_FAILS: '1' });
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes("The worker is installed but this Mac isn't signed in. Run the line again; with --link, get a new code from the website first."));
  assert.ok(!r.stdout.includes('Done.'));
});
