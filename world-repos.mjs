// The repositories World counts besides the ones agent sessions worked in: someone coding by hand has no sessions, so
// they add the repositories themselves (the panel's Repositories part, or `node server.mjs world add <folder>`).
//   world/repos.json beside world.json: { "added": [paths], "removed": [paths] }, every path real (`realpathSync.native`:
//   the Mac's disk ignores case). `removed` keeps a repository an agent found from being counted again. A missing or
//   broken file reads as empty. Paths stay on this Mac: nothing here goes to the hub.

import fs from 'node:fs';
import path from 'node:path';

/** A folder's true path, or the path as given when there is no such folder. */
export const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
/** A repository has `.git`: a folder, or in a linked worktree a file. */
const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));
const strings = (v) => (Array.isArray(v) ? [...new Set(v.filter((p) => typeof p === 'string' && p))] : []);

export function readRepos(file) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
  return { added: strings(j.added), removed: strings(j.removed) };
}

function write(file, repos) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(repos) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const MOST_DEEP = 3;
/** Every repository at most 3 levels under `dir`, sorted. A repository found is not looked inside (its submodules and
 *  vendored copies are not new work), and `node_modules` and dot-folders are skipped. Symlinks are not followed. */
export function findRepos(dir) {
  const found = [];
  const walk = (d, level) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const sub = path.join(d, e.name);
      if (isRepo(sub)) found.push(real(sub));
      else if (level < MOST_DEEP) walk(sub, level + 1);
    }
  };
  walk(real(dir), 1);
  return found.sort();
}

/** Counts `dir` when it is a repository, else every repository `find` gives for it. Not a folder: nothing. */
export function addRepos(file, dir, { find = findRepos } = {}) {
  const top = real(dir);
  if (!isDir(top)) return { added: [] };
  const found = isRepo(top) ? [top] : find(top).map(real);
  if (found.length) {
    const was = readRepos(file);
    write(file, { added: [...new Set([...was.added, ...found])], removed: was.removed.filter((p) => !found.includes(p)) });
  }
  return { added: found };
}

/** Stops counting a repository, whoever found it. False when it was already stopped. */
export function removeRepo(file, dir) {
  const p = real(dir), was = readRepos(file);
  if (!was.added.includes(p) && was.removed.includes(p)) return false;
  write(file, { added: was.added.filter((q) => q !== p), removed: [...new Set([...was.removed, p])] });
  return true;
}

/** What is counted: the repositories agent sessions found, plus the added, minus the removed; each with where it came
 *  from (a repository both found and added counts as added by hand). */
export function reposOf(found, { added, removed }) {
  const out = new Map();
  for (const p of found) out.set(p, 'agent');
  for (const p of added) out.set(p, 'hand');
  for (const p of removed) out.delete(p);
  return [...out].map(([p, by]) => ({ path: p, by }));
}
