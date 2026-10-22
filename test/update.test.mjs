// The worker's own update: a temp `worker/` folder with a running version A and `current` pointing at it, a release
// archive built with the real tar, and a fake hub that names a release. `exit` is a spy, so a switch is seen, not done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { workerOf, markStarted, rolledBack, prune, checkForUpdate, releaseOf, writeRelease, recordCheck, lastCheck, safeLine } from '../update.mjs';
import { rawPublicKey, signRelease } from '../release-keys.mjs';

const A = '1'.repeat(40), B = '2'.repeat(40);
// The release keys of these tests are made here, so no key is committed; B is release N, signed by the one key.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = rawPublicKey(publicKey), N = 5, SIG = signRelease(N, B, privateKey);
// The only place a release is fetched from, whatever the hub's answer says.
const ARCHIVE = `https://codeload.github.com/IcyDingo/agent-control-panel/tar.gz/${B}`;
// Where the worker asks GitHub whether B is on main.
const COMPARE = `https://api.github.com/repos/IcyDingo/agent-control-panel/compare/main...${B}`;
// Where it asks GitHub whether B descends from A, the release it runs.
const DESCENT = `https://api.github.com/repos/IcyDingo/agent-control-panel/compare/${A}...${B}`;
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

/** A fake network: the hub's `/api/release` answers `release` (a Response, or a function that throws), GitHub's compare
 * of main with B `compare` (by default B is behind main, so on it), its compare of A with B `descent` (by default B is
 * ahead of A, so it follows the running release), GitHub's archive address for B the bytes, and any other address (the
 * hub's own `url` among them) a 404. Every call is recorded. */
function hub(release, bytes = null, compare = () => json({ status: 'behind' }), descent = () => json({ status: 'ahead' })) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), redirect: init.redirect, ...(init.headers ? { accept: init.headers.accept } : {}) });
    if (String(url) === 'http://hub.test/api/release') return typeof release === 'function' ? release() : release;
    if (String(url) === COMPARE) return compare();
    if (String(url) === DESCENT) return descent();
    if (String(url) === ARCHIVE) return new Response(bytes);
    return json({ ok: false, error: 'Not found.' }, 404);
  };
  fn.calls = calls;
  return fn;
}
const names = (sha, extra = {}) => json({ ok: true, sha, n: N, sigs: [SIG], url: 'http://hub.test/archive.tgz', ...extra });

function check(w, fetch) {
  const exits = [], logs = [];
  const result = checkForUpdate({ worker: w, hubUrl: 'http://hub.test', fetch, run, keys: [PUB], exit: (c) => exits.push(c), log: (m) => logs.push(m) });
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
  const r = await check(w, hub(names(A, { sigs: [signRelease(N, A, privateKey)] })));
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
  assert.equal(fs.existsSync(path.join(w.dir, 'switch.new')), false, 'switch is written beside and renamed over');
  assert.deepEqual(r.exits, [0]);
  assert.deepEqual(leftovers(w.dir), []);
  assert.deepEqual([lastCheck(w.dir).outcome, lastCheck(w.dir).sha], ['switched', B], 'recorded before the exit, since the exit ends the process');
});

test('a release is downloaded only once GitHub says it is on main', async () => {
  for (const status of ['identical', 'behind']) {
    const w = worker();
    const fetch = hub(names(B), archive(`agent-control-panel-${B}`), () => json({ status }));
    const r = await check(w, fetch);
    assert.equal(r.outcome, 'switched', status);
    assert.deepEqual(fetch.calls.map((c) => c.url), ['http://hub.test/api/release', COMPARE, DESCENT, ARCHIVE]);
    assert.deepEqual(fetch.calls[1], { url: COMPARE, redirect: 'error', accept: 'application/vnd.github+json' });
    assert.deepEqual(fetch.calls[2], { url: DESCENT, redirect: 'error', accept: 'application/vnd.github+json' });
  }
});

test('a release that does not descend from the running one is an error and nothing is downloaded', async () => {
  const answers = {
    behind: () => json({ status: 'behind' }),
    diverged: () => json({ status: 'diverged' }),
    identical: () => json({ status: 'identical' }),
    'a 404': () => json({ message: 'Not Found' }, 404),
    'a thrown error': () => { throw new TypeError('fetch failed'); },
  };
  for (const [what, descent] of Object.entries(answers)) {
    const w = worker();
    const fetch = hub(names(B), archive(`agent-control-panel-${B}`), undefined, descent);
    const r = await check(w, fetch);
    assert.deepEqual([r.outcome, r.error], ['error', 'Release 2222222 does not follow the release running here.'], what);
    assert.deepEqual(fetch.calls.map((c) => c.url), ['http://hub.test/api/release', COMPARE, DESCENT], what);
    assert.equal(fs.existsSync(path.join(w.dir, 'switch')), false, what);
    assert.equal(fs.existsSync(path.join(w.dir, B)), false, what);
    assert.equal(fs.readlinkSync(path.join(w.dir, 'current')), path.join(w.dir, A), what);
    assert.equal(releaseOf(w.dir), null, `${what}: no number is recorded`);
    assert.deepEqual(r.exits, [], what);
  }
});

test('a release with the same number as the one on record but another commit is installed only when it descends', async () => {
  const w = worker();
  writeRelease(w.dir, A, N);
  const refused = await check(w, hub(names(B), archive(`agent-control-panel-${B}`), undefined, () => json({ status: 'behind' })));
  assert.equal(refused.error, 'Release 2222222 does not follow the release running here.');
  assert.deepEqual(releaseOf(w.dir), { sha: A, n: N });
  const ok = await check(w, hub(names(B), archive(`agent-control-panel-${B}`)));
  assert.equal(ok.outcome, 'switched');
});

test('a release that is not on main, as a fork\'s commit would be, is an error and nothing is downloaded', async () => {
  for (const status of ['ahead', 'diverged']) {
    const w = worker();
    const fetch = hub(names(B), archive(`agent-control-panel-${B}`), () => json({ status }));
    const r = await check(w, fetch);
    assert.deepEqual([r.outcome, r.error], ['error', 'Release 2222222 is not on main.'], status);
    assert.equal(fetch.calls.some((c) => c.url === ARCHIVE), false);
    assert.equal(fs.readlinkSync(path.join(w.dir, 'current')), path.join(w.dir, A));
    assert.equal(fs.existsSync(path.join(w.dir, B)), false);
    assert.deepEqual(r.exits, []);
  }
});

test('when GitHub does not answer the compare, nothing is downloaded', async () => {
  for (const compare of [() => json({ message: 'Server Error' }, 500), () => { throw new TypeError('fetch failed'); }]) {
    const w = worker();
    const fetch = hub(names(B), archive(`agent-control-panel-${B}`), compare);
    const r = await check(w, fetch);
    assert.deepEqual([r.outcome, r.error], ['error', 'GitHub did not answer.']);
    assert.equal(fetch.calls.some((c) => c.url === ARCHIVE), false);
    assert.equal(fs.existsSync(path.join(w.dir, 'switch')), false);
  }
});

test("the release is fetched from GitHub's archive for that commit, never from the address the hub gives", async () => {
  const w = worker();
  const fetch = hub(names(B, { url: 'http://elsewhere.test/archive.tgz' }), archive(`agent-control-panel-${B}`));
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

test('a release the keys did not sign is an error with no compare and no download', async () => {
  const w = worker();
  for (const bad of [{ sigs: [] }, { sigs: ['x'.repeat(86)] }, { sigs: undefined }, { n: '5' }, { n: 5.5 }, { n: 0 }, { sigs: SIG }]) {
    const fetch = hub(names(B, bad), archive(`agent-control-panel-${B}`));
    const r = await check(w, fetch);
    assert.deepEqual([r.outcome, r.error], ['error', `Release ${B.slice(0, 7)} is not signed by a known key.`], JSON.stringify(bad));
    assert.equal(fetch.calls.length, 1, 'only the hub was asked');
    assert.equal(fs.existsSync(path.join(w.dir, 'switch')), false);
  }
  const other = generateKeyPairSync('ed25519');
  const fetch = hub(names(B, { sigs: [signRelease(N, B, other.privateKey)] }), archive(`agent-control-panel-${B}`));
  assert.equal((await check(w, fetch)).error, `Release ${B.slice(0, 7)} is not signed by a known key.`, 'an unknown key');
  assert.equal((await checkForUpdate({ worker: w, hubUrl: 'http://hub.test', fetch: hub(names(B)), run, keys: [], exit: () => {}, log: () => {} })).outcome, 'error', 'no keys, nothing installs');
});

test('a release numbered below the one on record is an error; the record is written at a switch and rewritten after corruption', async () => {
  const w = worker();
  writeRelease(w.dir, A, 9);
  const fetch = hub(names(B), archive(`agent-control-panel-${B}`));
  const r = await check(w, fetch);
  assert.deepEqual([r.outcome, r.error], ['error', `Release ${B.slice(0, 7)} is older than the one running.`]);
  assert.equal(fetch.calls.length, 1);
  for (const junk of ['garbage\n', `${A}\n`, `${A} x\n`, '']) {
    fs.writeFileSync(path.join(w.dir, 'release'), junk);
    assert.equal(releaseOf(w.dir), null, JSON.stringify(junk));
  }
  const ok = await check(w, hub(names(B), archive(`agent-control-panel-${B}`)));
  assert.equal(ok.outcome, 'switched', 'a corrupt record is no floor');
  assert.deepEqual(releaseOf(w.dir), { sha: B, n: N });
});

test('the same sha records its number the first time, so a fresh install gets a floor at its first check', async () => {
  const w = worker();
  const r = await check(w, hub(names(A, { sigs: [signRelease(N, A, privateKey)] })));
  assert.equal(r.outcome, 'current');
  assert.deepEqual(releaseOf(w.dir), { sha: A, n: N });
});

test('recordCheck and lastCheck keep the last outcome and its sentence', () => {
  const w = worker();
  assert.equal(lastCheck(w.dir), null);
  recordCheck(w.dir, { outcome: 'error', error: 'Release 2222222 is not signed by a known key.' }, () => Date.parse('2026-10-22T10:00:00Z'));
  assert.deepEqual(lastCheck(w.dir), { at: '2026-10-22T10:00:00.000Z', outcome: 'error', error: 'Release 2222222 is not signed by a known key.' });
  recordCheck(w.dir, { outcome: 'current' });
  assert.equal(lastCheck(w.dir).outcome, 'current');
  fs.writeFileSync(path.join(w.dir, 'last-check'), '{');
  assert.equal(lastCheck(w.dir), null);
});

test('the hub\'s error is shown only when it is a sentence, and safeLine makes text fit for a terminal', async () => {
  const w = worker();
  for (const error of [{ x: 1 }, '', 0, null]) {
    const r = await check(w, hub(json({ ok: false, error }, 503)));
    assert.deepEqual([r.outcome, r.error], ['error', 'The hub answered 503.'], JSON.stringify(error));
  }
  const r = await check(w, hub(json({ ok: false, error: 'a\u001b[31mb\nc' }, 503)));
  assert.equal(r.error, 'a\u001b[31mb\nc', 'the record keeps what the hub said');
  assert.equal(safeLine(r.error), 'a[31mbc');
  assert.equal(safeLine('x'.repeat(300)).length, 200);
  assert.equal(safeLine(undefined), '');
  assert.equal(safeLine('a\x7fb\x00c'), 'abc');
});
