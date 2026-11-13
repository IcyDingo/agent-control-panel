// What the Linux app (main.mjs) works out before it touches Electron. Everything here is a function of its
// arguments and imports nothing from Electron, so the tests run on plain Node.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- the environment the server gets

/**
 * The app's environment without what an AppImage and Electron put in it. An AppImage puts its mount folder at the
 * front of PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS and others; handed on, every session the panel starts, and every
 * program run from one, would load the app's libraries instead of the system's.
 */
export function cleanEnv(env) {
  const appDir = String(env.APPDIR ?? '').replace(/\/+$/, '');
  const inside = (p) => appDir && (p === appDir || p.startsWith(appDir + '/'));
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (['APPDIR', 'APPIMAGE', 'OWD', 'ARGV0', 'CHROME_DESKTOP'].includes(k) || /^(APPIMAGE|ELECTRON)_/.test(k)) continue;
    if (appDir && String(v).includes(appDir)) {
      const kept = String(v).split(':').filter((p) => !inside(p)).join(':');
      if (kept) out[k] = kept;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** One PATH from several, in the order given, each folder once. Each part is a colon list, an array, or nothing. */
export function mergePath(...parts) {
  const seen = new Set();
  for (const part of parts) for (const dir of Array.isArray(part) ? part : String(part ?? '').split(':')) if (dir) seen.add(dir);
  return [...seen].join(':');
}

const MARK = '__glue_path__';

/**
 * The command that makes the login shell print its PATH between two marks. An app opened from a launcher gets the
 * session's PATH, which often lacks what the shell's startup files add (~/.local/bin, nvm, linuxbrew): the folders
 * Claude Code and Node are in. Null when there is no shell to ask.
 * @returns {{cmd: string, args: string[]} | null}
 */
export function shellPathCommand(shell) {
  if (!path.isAbsolute(String(shell ?? ''))) return null;
  const name = path.basename(shell);
  const print = (value) => `printf '%s' '${MARK}'; printf '%s' ${value}; printf '%s' '${MARK}'`;
  if (name === 'fish') return { cmd: shell, args: ['-ilc', print('(string join : $PATH)')] };
  // bash and zsh read the files that set PATH only when interactive; a plain sh has no such files to read.
  return { cmd: shell, args: [['bash', 'zsh'].includes(name) ? '-ilc' : '-lc', print('"$PATH"')] };
}

/** The PATH from that command's output, past anything the shell's startup files printed; null when it isn't there. */
export function parseShellPath(stdout) {
  const m = new RegExp(`${MARK}(.+?)${MARK}`, 's').exec(String(stdout ?? ''));
  return m ? m[1] : null;
}

/** Whether `version` is `min` or newer, comparing each number. Anything that isn't a version is not. */
export function atLeast(version, min) {
  const nums = (s) => (/^\d+(?:\.\d+)*/.exec(String(s ?? '').trim())?.[0] ?? '').split('.').filter(Boolean).map(Number);
  const a = nums(version), b = nums(min);
  if (!a.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// ---------------------------------------------------------------- the page

/** "(3) Glue" → 3: the requests waiting on you, as the page counts them in its title. */
export function waitingCount(title) {
  return Number(/^\((\d+)\)/.exec(String(title ?? ''))?.[1] ?? 0);
}

/** Whether a URL is the panel on this app's port: the only thing that loads in the window. */
export function isPanelUrl(url, port) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) && Number(u.port) === Number(port);
}

/** Whether a link may be handed to the desktop to open: a web page or an email address, nothing else. */
export function opensOutside(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return ['http:', 'https:', 'mailto:'].includes(u.protocol);
}

// ---------------------------------------------------------------- launcher entries

/**
 * A desktop entry for Glue: the one in the applications menu (an AppImage has none until it writes its own), or with
 * `autostart` the one that opens it hidden at login. `exec` is quoted as the Desktop Entry spec reads it.
 */
export function desktopEntry({ exec, icon, autostart = false }) {
  const quoted = `"${String(exec).replace(/[\\"`$]/g, '\\$&').replaceAll('%', '%%')}"`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Glue',
    'Comment=Every Claude Code session on this computer, in one window',
    `Exec=${quoted}${autostart ? ' --hidden' : ''}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=glue',
    ...(autostart ? ['X-GNOME-Autostart-enabled=true'] : []),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- whose server

const signalable = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }; // EPERM: another user's
const procCommand = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { return null; } };

/**
 * The pid of the server this app started earlier and that is still running, from the pid file it left; null when
 * there is none. A panel answering on the port that isn't this one belongs to someone else (another user of the
 * computer, or a server started by hand), and the app leaves it alone rather than show it.
 */
export function ownServer(pidFile, { alive = signalable, commandOf = procCommand } = {}) {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return null;
  const command = commandOf(pid); // null where /proc can't say (not Linux): the live pid has to do
  return command === null || command.includes('server.mjs') ? pid : null;
}
