// Which terminal app a Linux desktop has, and how each is told to run a script. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalCommand } from '../terminal.mjs';

const SCRIPT = '/home/x/.config/glue/trust/login-1.sh';
/** A machine with these programs installed, each in /usr/bin unless it is given as a path. */
const machine = (...installed) => {
  const files = new Set(installed.map((p) => (p.startsWith('/') ? p : `/usr/bin/${p}`)));
  return (file) => files.has(file);
};
const pick = (env, ...installed) => terminalCommand(SCRIPT, { env: { PATH: '/usr/local/bin:/usr/bin', ...env }, isExecutable: machine(...installed) });

test('each terminal is told to run the script in the way it understands', () => {
  assert.deepEqual(pick({}, 'gnome-terminal'), { cmd: '/usr/bin/gnome-terminal', args: ['--', SCRIPT] });
  assert.deepEqual(pick({}, 'konsole'), { cmd: '/usr/bin/konsole', args: ['-e', SCRIPT] });
  assert.deepEqual(pick({}, 'xfce4-terminal'), { cmd: '/usr/bin/xfce4-terminal', args: ['-x', SCRIPT] });
  assert.deepEqual(pick({}, 'kitty'), { cmd: '/usr/bin/kitty', args: [SCRIPT] });
  assert.deepEqual(pick({}, 'wezterm'), { cmd: '/usr/bin/wezterm', args: ['start', '--', SCRIPT] });
});

test("the desktop's own chooser comes before any one terminal", () => {
  assert.deepEqual(pick({}, 'xterm', 'gnome-terminal', 'xdg-terminal-exec'), { cmd: '/usr/bin/xdg-terminal-exec', args: [SCRIPT] });
  assert.deepEqual(pick({}, 'xterm', 'konsole', 'x-terminal-emulator'), { cmd: '/usr/bin/x-terminal-emulator', args: ['-e', SCRIPT] });
});

test('$TERMINAL wins when it is installed, as a name or as a path', () => {
  assert.deepEqual(pick({ TERMINAL: 'kitty' }, 'kitty', 'xdg-terminal-exec'), { cmd: '/usr/bin/kitty', args: [SCRIPT] });
  assert.deepEqual(pick({ TERMINAL: '/opt/t/bin/alacritty' }, '/opt/t/bin/alacritty', 'xterm'), { cmd: '/opt/t/bin/alacritty', args: ['-e', SCRIPT] });
  assert.deepEqual(pick({ TERMINAL: 'st' }, 'st'), { cmd: '/usr/bin/st', args: ['-e', SCRIPT] }, 'one it has never heard of gets -e, which most take');
});

test('a $TERMINAL that is not installed is passed over', () => {
  assert.deepEqual(pick({ TERMINAL: 'ghostty' }, 'xterm'), { cmd: '/usr/bin/xterm', args: ['-e', SCRIPT] });
});

test('with no terminal installed there is nothing to run', () => {
  assert.equal(pick({}), null);
  assert.equal(pick({ TERMINAL: 'kitty' }, 'firefox'), null);
  assert.equal(terminalCommand(SCRIPT, { env: {}, isExecutable: machine('xterm') }), null, 'no PATH to look along');
});
