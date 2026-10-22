// The worker updates itself. An installed worker runs from `worker/<sha>/`, with `worker/current` pointing at it and
// launchd starting a fixed launcher (`worker/run.sh`) that runs `current/server.mjs`. Once a day the running version asks
// the hub which release is out; a new one that GitHub says is on main is unpacked beside it, `current` is pointed at
// it, and the process exits so launchd starts the launcher again. The launcher reads `switch` (`<to> <from> <tries>`)
// and goes back to `<from>` after three failed starts, writing `rolled-back`; a version that starts proves itself by
// writing `started`.
// Nothing here throws: an update that cannot be done leaves the running version as it was.

import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_KEYS, validN, verifyRelease } from './release-keys.mjs';

export const SHA_RE = /^[0-9a-f]{40}$/;
// A release is fetched from GitHub's archive of this repository, never from an address the hub gives: the hub only names
// the commit, so a hub that is wrong or not the hub at all can at most point at code that was really published here.
const ARCHIVE_URL = 'https://codeload.github.com/IcyDingo/agent-control-panel/tar.gz/';
// GitHub serves every commit of the repository's fork network under that same archive address, so the address alone
// does not hold the hub to code published here. Before a download, GitHub is asked how the commit compares with main.
const COMPARE_URL = 'https://api.github.com/repos/IcyDingo/agent-control-panel/compare/main...';

const RELEASE_TIMEOUT_MS = 8000;
// A release is the whole repository; a slow line may need a while, but a download that never ends must not hang forever.
const DOWNLOAD_TIMEOUT_MS = 300_000;

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const remove = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

/** `{ dir, sha }` when `scriptDir` really is `<dir>/<sha>` inside a folder named `worker`; a clone of the repo is null. */
export function workerOf(scriptDir) {
  let real;
  try { real = fs.realpathSync(scriptDir); } catch { return null; }
  const sha = path.basename(real), dir = path.dirname(real);
  return SHA_RE.test(sha) && path.basename(dir) === 'worker' ? { dir, sha } : null;
}

/** Tells the launcher this version started, so a switch to it counts as done. */
export function markStarted(worker) {
  fs.writeFileSync(path.join(worker.dir, 'started'), worker.sha + '\n');
}

/** Updates are on unless `update.json` says `{ "auto": false }`; a missing or unreadable file leaves them on. */
export function autoUpdate(dir) {
  try {
    const prefs = JSON.parse(read(path.join(dir, 'update.json')));
    return !(prefs && typeof prefs === 'object' && prefs.auto === false);
  } catch { return true; }
}

/** The release the launcher gave up on, from `rolled-back` (`<sha> <iso time>`), or null. */
export function rolledBack(dir) {
  const [sha, at] = (read(path.join(dir, 'rolled-back')) ?? '').trim().split(/\s+/);
  return SHA_RE.test(sha ?? '') && at ? { sha, at } : null;
}

/** Removes old versions and half-done downloads. It keeps the running version, the one `current` points at, and every
 * version `switch` or `rolled-back` names, since the launcher may still go back to one of them. */
export function prune(worker) {
  const keep = new Set([worker.sha]);
  try { keep.add(path.basename(fs.readlinkSync(path.join(worker.dir, 'current')))); } catch {}
  for (const sha of (read(path.join(worker.dir, 'switch')) ?? '').trim().split(/\s+/)) if (SHA_RE.test(sha)) keep.add(sha);
  const back = rolledBack(worker.dir);
  if (back) keep.add(back.sha);
  let entries = [];
  try { entries = fs.readdirSync(worker.dir); } catch { return; }
  for (const name of entries) {
    if ((SHA_RE.test(name) && !keep.has(name)) || name.endsWith('.tmp') || name.endsWith('.tgz')) remove(path.join(worker.dir, name));
  }
}

/** The release this worker last proved, from `release` (`<sha> <n>`), or null when it is missing or not that. */
export function releaseOf(dir) {
  const [sha, n, ...more] = (read(path.join(dir, 'release')) ?? '').trim().split(/\s+/);
  return SHA_RE.test(sha ?? '') && /^[0-9]+$/.test(n ?? '') && !more.length && validN(Number(n)) ? { sha, n: Number(n) } : null;
}

/** Records the release number this worker runs. It is written beside and renamed over, like `switch`. */
export function writeRelease(dir, sha, n) {
  fs.writeFileSync(path.join(dir, 'release.new'), `${sha} ${n}\n`);
  fs.renameSync(path.join(dir, 'release.new'), path.join(dir, 'release'));
}

/** Keeps the outcome of the last check (`last-check`, JSON), so `status` and the panel can say what happened. */
export function recordCheck(dir, result, now = Date.now) {
  const { outcome, sha, error } = result;
  const record = { at: new Date(now()).toISOString(), outcome, ...(sha !== undefined && { sha }), ...(error !== undefined && { error }) };
  fs.writeFileSync(path.join(dir, 'last-check.new'), JSON.stringify(record) + '\n');
  fs.renameSync(path.join(dir, 'last-check.new'), path.join(dir, 'last-check'));
}

/** The record `recordCheck` made, or null when there is none or it cannot be read. */
export function lastCheck(dir) {
  try {
    const record = JSON.parse(read(path.join(dir, 'last-check')));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch { return null; }
}

const errorOf = (err) => String(err?.message ?? err);

/** Null when `sha` is on main (GitHub's compare of main with it says `identical` or `behind`), else the error to report.
 * Only this unattended daily path asks: the install script does not, since the person running it is there, and the hub
 * they just visited is the same trust root as the script itself. */
async function notOnMain(sha, fetch) {
  let res, body;
  try {
    res = await fetch(COMPARE_URL + sha, { headers: { accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
    body = await res.json().catch(() => null);
  } catch { return 'GitHub did not answer.'; }
  if (res.ok && (body?.status === 'identical' || body?.status === 'behind')) return null;
  // A commit GitHub does not know in this repository is answered 404; anything else not ok means GitHub was not there.
  return res.ok || res.status === 404 ? `Release ${sha.slice(0, 7)} is not on main.` : 'GitHub did not answer.';
}

/** Asks the hub for its release and switches to it when a known key signed it, it is not the running one, and its number is
 * not below the one on record. The outcome says what happened: `off` (updates are turned off), `current` (already running it), `held` (the launcher rolled this release back, so it is
 * not tried again), `switched` (exit has been called), or `error`. */
export async function checkForUpdate({ worker, hubUrl, fetch = globalThis.fetch, run, keys = RELEASE_KEYS, now = Date.now, exit = (c) => process.exit(c), log = console.log }) {
  const { dir } = worker;
  if (!autoUpdate(dir)) return { outcome: 'off' };

  let release;
  try {
    const res = await fetch(`${hubUrl}/api/release`, { signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
    release = await res.json().catch(() => null);
    if (!res.ok || !release?.ok) return { outcome: 'error', error: release?.error ?? `The hub answered ${res.status}.` };
  } catch (err) { return { outcome: 'error', error: errorOf(err) }; }
  const { sha, n, sigs } = release;
  if (!SHA_RE.test(sha ?? '')) return { outcome: 'error', error: 'The hub named no release.' };
  // Nothing is fetched, compared or written for a release no known key signed.
  if (!verifyRelease(n, sha, sigs, keys)) return { outcome: 'error', error: `Release ${sha.slice(0, 7)} is not signed by a known key.` };
  // The number on record is a floor: a signature over an old release stays valid forever, so the number is what stops
  // someone holding a key from pointing a worker back at a release with a known flaw.
  const floor = releaseOf(dir);
  if (sha === worker.sha) {
    if (!floor || floor.n < n) { try { writeRelease(dir, sha, n); } catch {} }
    prune(worker);
    return { outcome: 'current' };
  }
  if (rolledBack(dir)?.sha === sha) return { outcome: 'held', sha };
  if (floor && floor.n > n) return { outcome: 'error', error: `Release ${sha.slice(0, 7)} is older than the one running.` };
  const off = await notOnMain(sha, fetch);
  if (off) return { outcome: 'error', error: off };

  const tgz = path.join(dir, `${sha}.tgz`), tmp = path.join(dir, `${sha}.tmp`), dest = path.join(dir, sha);
  const top = `agent-control-panel-${sha}`;
  const sw = path.join(dir, 'switch'), swNew = path.join(dir, 'switch.new'), link = path.join(dir, 'current.new');
  const made = []; // the paths this check writes, which a failure takes away again
  try {
    // No redirects: the archive must come from codeload itself.
    const res = await fetch(ARCHIVE_URL + sha, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`The release archive answered ${res.status}.`);
    made.push(tgz);
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    remove(tmp);
    made.push(tmp);
    fs.mkdirSync(tmp);
    const r = await run('tar', ['-xzf', tgz, '-C', tmp]);
    if (r.err) throw new Error(`The release archive could not be unpacked: ${(r.stderr || errorOf(r.err)).trim()}`);
    // The archive must be the release it claims to be: one folder, named for that commit.
    const got = fs.readdirSync(tmp);
    if (got.length !== 1 || got[0] !== top) throw new Error(`The release archive does not hold ${top}.`);
    remove(dest);
    made.push(dest);
    fs.renameSync(path.join(tmp, top), dest);
    // The `switch` format (`<to> <from> <tries>`) is frozen, because the launcher that reads it is never updated. It is
    // written beside and renamed over, so the launcher never reads half a file.
    made.push(swNew, sw);
    fs.writeFileSync(swNew, `${sha} ${worker.sha} 0\n`);
    fs.renameSync(swNew, sw);
    writeRelease(dir, sha, n);
    // A new link renamed over the old one replaces the link itself in one step; `current` is never missing or half made.
    remove(link);
    made.push(link);
    fs.symlinkSync(dest, link);
    fs.renameSync(link, path.join(dir, 'current'));
  } catch (err) {
    for (const p of made) remove(p);
    return { outcome: 'error', error: errorOf(err) };
  }
  remove(tgz);
  remove(tmp);
  prune(worker);
  log(`worker: switching to ${sha}`);
  exit(0);
  return { outcome: 'switched', sha };
}
