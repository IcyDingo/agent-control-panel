// Where Glue keeps its data and its logs, per platform. On a Mac that is ~/Library, as it has always been. Elsewhere
// it is the XDG folders: ~/.config/glue for data (prefs, the GitHub cache, the sign-in scripts) and
// ~/.local/state/glue for logs. The server (cli.mjs) and the Linux app (desktop/main.mjs) both read these.

import os from 'node:os';
import path from 'node:path';

/** An XDG variable counts only when it is an absolute path; the spec says to ignore anything else. */
const xdg = (value, fallback) => (path.isAbsolute(String(value ?? '')) ? String(value) : fallback);

/** The folder for prefs.json and what sits beside it. */
export function dataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Glue');
  return path.join(xdg(env.XDG_CONFIG_HOME, path.join(home, '.config')), 'glue');
}

/** The folder for the server's log. */
export function logDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Logs', 'Glue');
  return path.join(xdg(env.XDG_STATE_HOME, path.join(home, '.local', 'state')), 'glue');
}
