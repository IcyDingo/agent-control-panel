// Agent Panel is now Glue. What an install under the old name left behind moves across once, so nothing is lost: the
// prefs, the overseer's conversation, the PR watcher's memory and GitHub's state (Application Support), and the logs.
//
// A folder moves whole when Glue has none yet. When both exist (an old server wrote after the new one started), each
// entry Glue lacks moves in, Glue's own copy wins, and the old folder goes once it is empty. It never throws: a move
// that fails leaves the old folder where it was, and the panel starts with what Glue has.

import fs from 'node:fs';
import path from 'node:path';

export const OLD_NAME = 'Agent Panel';
export const NAME = 'Glue';

/** The folders that carry the name, old and new. */
export const folders = (home) => ['Application Support', 'Logs'].map((kind) => ({
  from: path.join(home, 'Library', kind, OLD_NAME), to: path.join(home, 'Library', kind, NAME),
}));

/** Moves the old folders' contents under the new name. Returns what moved, as `from → to` pairs, for the log. */
export function migrateFolders({ home, fsys = fs } = {}) {
  const moved = [];
  for (const { from, to } of folders(home)) {
    try {
      if (!fsys.existsSync(from)) continue;
      if (!fsys.existsSync(to)) {
        fsys.mkdirSync(path.dirname(to), { recursive: true });
        fsys.renameSync(from, to);
        moved.push([from, to]);
        continue;
      }
      for (const name of fsys.readdirSync(from)) {
        const a = path.join(from, name), b = path.join(to, name);
        if (fsys.existsSync(b)) continue; // Glue's own copy is the newer one
        fsys.renameSync(a, b);
        moved.push([a, b]);
      }
      if (!fsys.readdirSync(from).length) fsys.rmdirSync(from);
    } catch {}
  }
  return moved;
}
