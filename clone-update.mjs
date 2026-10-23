// A panel run from a git clone (./install.sh) does not update itself the way the worker does: the clone is the owner's
// own folder, so changing it is their call. It does say when the hub runs a newer release a known key signed, and on
// request it fast-forwards to that release on main and rebuilds the app; the server then restarts on the new code. Only
// main, fast-forward only, and never over edits that aren't committed: a clone someone works in is left as it is, with
// the reason.
// Nothing here throws: an answer says what happened.

import fs from 'node:fs';
import path from 'node:path';
import { SHA_RE, safeLine } from './update.mjs';
import { RELEASE_KEYS, verifyRelease } from './release-keys.mjs';

const RELEASE_TIMEOUT_MS = 8000;
const errorOf = (err) => String(err?.message ?? err);
const firstLine = (r) => (r.stderr || r.stdout || errorOf(r.err)).trim().split('\n').filter(Boolean).at(-1) ?? '';

/** Why this clone can't be updated by a click, or null: it must be on main with no uncommitted edits to tracked files. */
async function blockedWhy(repo, run) {
  const branch = await run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.err) return 'git could not read this folder.';
  const name = branch.stdout.trim();
  if (name !== 'main') return `This folder is on the branch ${name}, not main.`;
  const status = await run('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no']);
  if (status.err) return 'git could not read this folder.';
  return status.stdout.trim() ? "This folder has changes that aren't committed." : null;
}

/** Asks the hub which release it runs and compares it with the clone. `current` (the clone runs it, or has it in its
 *  history), `available` (with `blocked`: null, or why a click can't take it), or `error`. A release no known key signed
 *  is an error, as it is for a worker: the board never offers one. */
export async function checkClone({ repo, hubUrl, fetch = globalThis.fetch, run, keys = RELEASE_KEYS }) {
  let release;
  try {
    const res = await fetch(`${hubUrl}/api/release`, { signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
    release = await res.json().catch(() => null);
    if (!res.ok || !release?.ok) {
      const said = release?.error;
      return { outcome: 'error', error: typeof said === 'string' && said ? safeLine(said) : `The hub answered ${res.status}.` };
    }
  } catch (err) { return { outcome: 'error', error: errorOf(err) }; }
  const { sha, n, sigs } = release;
  if (!SHA_RE.test(sha ?? '')) return { outcome: 'error', error: 'The hub named no release.' };
  if (!verifyRelease(n, sha, sigs, keys)) return { outcome: 'error', error: `Release ${sha.slice(0, 7)} is not signed by a known key.` };
  const head = await run('git', ['-C', repo, 'rev-parse', 'HEAD']);
  if (head.err) return { outcome: 'error', error: 'git could not read this folder.' };
  const at = head.stdout.trim();
  if (sha === at) return { outcome: 'current' };
  // Already in the clone's history (the clone is ahead of the hub): nothing to take. A commit the clone has never
  // fetched is not an ancestor either, and that is the usual new release.
  if (!(await run('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, 'HEAD'])).err) return { outcome: 'current' };
  return { outcome: 'available', sha, head: at, blocked: await blockedWhy(repo, run) };
}

/** The Agent Panel.app running for the panel in `repo` on `port` (build.sh bakes both into its Info.plist), or null.
 *  Whichever process started the server, that app starts a new one when the server goes away; and its bundle is where a
 *  rebuilt app belongs. */
export async function appFor({ repo, port, run }) {
  const ps = await run('ps', ['-axo', 'comm=']), exe = '/Contents/MacOS/AgentPanel';
  if (ps.err) return null;
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } }, here = real(repo);
  for (const line of new Set(ps.stdout.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.app' + exe)))) {
    const app = line.slice(0, -exe.length), plist = path.join(app, 'Contents', 'Info.plist');
    const [p, r] = await Promise.all(['ACPPort', 'ACPRepo'].map((k) => run('plutil', ['-extract', k, 'raw', plist])));
    if (!p.err && !r.err && p.stdout.trim() === String(port) && real(r.stdout.trim()) === here) return app;
  }
  return null;
}

/** Fetches main and fast-forwards the clone to `sha`, the signed release `checkClone` found, which must be on main there:
 *  the clone lands on that release, not on whatever main has gained since it was signed. Then it rebuilds the app with
 *  app/build.sh when the clone has one, at `appPath` when the running app's place is known (build.sh's default is
 *  ~/Applications). The new code is in place once the fast-forward worked, so a build that fails still answers ok, with
 *  `built: false` and why. */
export async function updateClone({ repo, sha, run, appPath = null }) {
  if (!SHA_RE.test(sha ?? '')) return { ok: false, error: 'There is no release to update to.' };
  const blocked = await blockedWhy(repo, run);
  if (blocked) return { ok: false, error: blocked };
  const fetched = await run('git', ['-C', repo, 'fetch', '-q', 'origin', 'main'], { timeout: 120_000 });
  if (fetched.err) return { ok: false, error: `git fetch did not work: ${firstLine(fetched)}` };
  if ((await run('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, 'FETCH_HEAD'])).err) {
    return { ok: false, error: `Release ${sha.slice(0, 7)} is not on main in this folder's origin.` };
  }
  const merge = await run('git', ['-C', repo, 'merge', '-q', '--ff-only', sha], { timeout: 120_000 });
  if (merge.err) return { ok: false, error: `git could not fast-forward: ${firstLine(merge)}` };
  const build = path.join(repo, 'app', 'build.sh');
  if (!fs.existsSync(build)) return { ok: true, sha, built: false };
  const b = await run(build, [], { cwd: repo, timeout: 300_000, ...(appPath && { env: { ...process.env, AGENT_PANEL_APP: appPath } }) });
  return b.err ? { ok: true, sha, built: false, buildError: firstLine(b) } : { ok: true, sha, built: true };
}
