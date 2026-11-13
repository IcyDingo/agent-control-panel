// A terminal window on a Linux desktop, running one script: where Claude Code's sign-in and its trust prompt wait for
// you. A Mac has one Terminal, opened with `open -a Terminal` (server.mjs). Linux has many, and each has its own way of
// being told what to run, so they are tried in order: the one you named in $TERMINAL, the desktop's own chooser, then
// the common ones.

import fs from 'node:fs';
import path from 'node:path';

/** Each terminal, in the order tried, with the arguments that go before the program it is to run. */
export const TERMINALS = [
  ['xdg-terminal-exec', []],      // the freedesktop chooser: runs whichever terminal the desktop has set as default
  ['x-terminal-emulator', ['-e']], // Debian's and Ubuntu's link to the default one
  ['gnome-terminal', ['--']],
  ['ptyxis', ['--']],
  ['kgx', ['-e']],                // GNOME Console
  ['konsole', ['-e']],
  ['xfce4-terminal', ['-x']],
  ['alacritty', ['-e']],
  ['kitty', []],
  ['foot', []],
  ['wezterm', ['start', '--']],
  ['xterm', ['-e']],
];
const FLAGS = new Map(TERMINALS);

const executable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };

/**
 * The command that opens a terminal window running `script` (an executable file with its own first line), or null
 * when no terminal is installed. `isExecutable` answers for the file system, so tests can describe a machine.
 * @returns {{cmd: string, args: string[]} | null}
 */
export function terminalCommand(script, { env = process.env, isExecutable = executable } = {}) {
  const dirs = String(env.PATH ?? '').split(':').filter(Boolean);
  const find = (name) => (name.includes('/') ? [name] : dirs.map((d) => path.join(d, name))).find(isExecutable);
  const named = String(env.TERMINAL ?? '').trim();
  // One the table doesn't know gets -e, which nearly every terminal takes.
  const tries = [...(named ? [[named, FLAGS.get(path.basename(named)) ?? ['-e']]] : []), ...TERMINALS];
  for (const [name, flags] of tries) {
    const cmd = find(name);
    if (cmd) return { cmd, args: [...flags, script] };
  }
  return null;
}
