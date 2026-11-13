// What the Linux app works out before it touches Electron: the environment it hands the server, the PATH, what a
// title and a link mean, the launcher entries it writes, and whether a server on its port is its own.
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanEnv, mergePath, shellPathCommand, parseShellPath, waitingCount, isPanelUrl, opensOutside, atLeast,
  desktopEntry, ownServer } from '../desktop/lib.mjs';

test('what an AppImage adds to the environment never reaches the server', () => {
  const env = cleanEnv({
    HOME: '/home/x', LANG: 'en_GB.UTF-8',
    APPDIR: '/tmp/.mount_GlueAb', APPIMAGE: '/home/x/Apps/Glue-x86_64.AppImage', OWD: '/home/x', ARGV0: './Glue-x86_64.AppImage',
    APPIMAGE_EXTRACT_AND_RUN: '1',
    PATH: '/tmp/.mount_GlueAb:/tmp/.mount_GlueAb/usr/sbin:/usr/local/bin:/usr/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_GlueAb/usr/lib',
    XDG_DATA_DIRS: '/tmp/.mount_GlueAb/usr/share:/usr/local/share:/usr/share',
    GSETTINGS_SCHEMA_DIR: '/tmp/.mount_GlueAb/usr/share/glib-2.0/schemas',
  });
  assert.deepEqual(env, { HOME: '/home/x', LANG: 'en_GB.UTF-8', PATH: '/usr/local/bin:/usr/bin', XDG_DATA_DIRS: '/usr/local/share:/usr/share' });
});

test("Electron's own switches are dropped, and a list that never held the AppImage is left alone", () => {
  const env = cleanEnv({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', CHROME_DESKTOP: 'glue.desktop',
    LD_LIBRARY_PATH: '/opt/cuda/lib', PATH: '/usr/bin', EDITOR: 'vim' });
  assert.deepEqual(env, { LD_LIBRARY_PATH: '/opt/cuda/lib', PATH: '/usr/bin', EDITOR: 'vim' });
});

test('a folder that only starts like the AppImage mount is not taken for it', () => {
  assert.equal(cleanEnv({ APPDIR: '/tmp/.mount_Glue', PATH: '/tmp/.mount_Glue/bin:/tmp/.mount_GlueOther/bin:/usr/bin' }).PATH, '/tmp/.mount_GlueOther/bin:/usr/bin');
});

test("the PATH is the login shell's first, then the app's, then the usual places, each folder once", () => {
  assert.equal(mergePath('/home/x/.nvm/bin:/usr/bin', '/usr/bin:/bin', ['/home/x/.local/bin', '/usr/bin', '']),
    '/home/x/.nvm/bin:/usr/bin:/bin:/home/x/.local/bin');
  assert.equal(mergePath(null, '/usr/bin', []), '/usr/bin');
});

test('each shell is asked for its PATH in its own words', () => {
  const bash = shellPathCommand('/bin/bash');
  assert.equal(bash.cmd, '/bin/bash');
  assert.deepEqual(bash.args.slice(0, 1), ['-ilc']);
  assert.match(bash.args[1], /"\$PATH"/);
  assert.deepEqual(shellPathCommand('/usr/bin/zsh').args.slice(0, 1), ['-ilc']);
  assert.match(shellPathCommand('/usr/bin/fish').args[1], /string join : \$PATH/, 'fish keeps PATH as a list');
  assert.deepEqual(shellPathCommand('/bin/dash').args.slice(0, 1), ['-lc'], 'a plain sh is not asked to be interactive');
  assert.equal(shellPathCommand(''), null);
  assert.equal(shellPathCommand('relative/shell'), null);
});

test("the PATH is read from between its marks, past whatever a shell's startup prints", () => {
  const { args } = shellPathCommand('/bin/bash');
  const mark = /printf '%s' '(.+?)'/.exec(args[1])[1];
  assert.equal(parseShellPath(`Welcome back!\n${mark}/home/x/bin:/usr/bin${mark}\n`), '/home/x/bin:/usr/bin');
  assert.equal(parseShellPath('Welcome back!\n'), null);
  assert.equal(parseShellPath(`${mark}${mark}`), null, 'an empty PATH is no PATH');
});

test('the count on the launcher is the one the page puts in its title', () => {
  assert.equal(waitingCount('(3) Glue'), 3);
  assert.equal(waitingCount('(12) Glue'), 12);
  assert.equal(waitingCount('Glue'), 0);
  assert.equal(waitingCount(''), 0);
  assert.equal(waitingCount('(soon) Glue'), 0);
});

test('only the panel on its own port loads in the window', () => {
  assert.equal(isPanelUrl('http://127.0.0.1:4747/', 4747), true);
  assert.equal(isPanelUrl('http://localhost:4747/vendor/xterm/xterm.js', 4747), true);
  assert.equal(isPanelUrl('http://127.0.0.1:4748/', 4747), false);
  assert.equal(isPanelUrl('https://127.0.0.1:4747/', 4747), false);
  assert.equal(isPanelUrl('http://127.0.0.1.evil.example:4747/', 4747), false);
  assert.equal(isPanelUrl('not a url', 4747), false);
});

test('a link goes to the browser only when it is a web page or an email address', () => {
  for (const u of ['https://github.com/IcyDingo/agent-control-panel/pull/1', 'http://example.com', 'mailto:someone@example.com']) assert.equal(opensOutside(u), true, u);
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'vscode://file/x', '']) assert.equal(opensOutside(u), false, u);
});

test('versions compare by number, not by letter', () => {
  assert.equal(atLeast('2.1.303', '2.1.303'), true);
  assert.equal(atLeast('2.10.0', '2.1.303'), true);
  assert.equal(atLeast('2.1.99', '2.1.303'), false);
  assert.equal(atLeast('3.0', '2.1.303'), true);
  assert.equal(atLeast('', '2.1.303'), false);
  assert.equal(atLeast('garbage', '2.1.303'), false);
});

test('the launcher entry names Glue, its icon and what to run, quoted the way a desktop reads it', () => {
  const entry = desktopEntry({ exec: '/home/x/My Apps/Glue-x86_64.AppImage', icon: 'glue' });
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\nName=Glue\n/);
  assert.match(entry, /^Exec="\/home\/x\/My Apps\/Glue-x86_64\.AppImage"$/m);
  assert.match(entry, /^Icon=glue$/m);
  assert.match(entry, /^StartupWMClass=glue$/m);
  assert.match(entry, /^Terminal=false$/m);
  assert.doesNotMatch(entry, /Autostart/);
  assert.ok(entry.endsWith('\n'));
});

test('the start-at-login entry opens Glue hidden', () => {
  const entry = desktopEntry({ exec: '/opt/Glue/glue', icon: 'glue', autostart: true });
  assert.match(entry, /^Exec="\/opt\/Glue\/glue" --hidden$/m);
  assert.match(entry, /^X-GNOME-Autostart-enabled=true$/m);
});

test('a path with characters a desktop entry treats specially is escaped', () => {
  assert.match(desktopEntry({ exec: '/home/x/50% "off" $HOME `it`\\Glue', icon: 'glue' }),
    /^Exec="\/home\/x\/50%% \\"off\\" \\\$HOME \\`it\\`\\\\Glue"$/m);
});

test("a server on the port is the app's own only when its pid file names a live process of this user's that is the server", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glue-own-'));
  const pidFile = path.join(dir, 'server-4747.pid');
  const mine = { alive: () => true, commandOf: () => '/opt/Glue/glue /opt/Glue/resources/app/server.mjs' };
  assert.equal(ownServer(pidFile, mine), null, 'no pid file: someone else started it');
  fs.writeFileSync(pidFile, '4321\n');
  assert.equal(ownServer(pidFile, mine), 4321);
  assert.equal(ownServer(pidFile, { ...mine, alive: () => false }), null, "gone, or another user's: not its to signal");
  assert.equal(ownServer(pidFile, { ...mine, commandOf: () => '/usr/bin/vim notes.txt' }), null, 'the pid went to another program since');
  assert.equal(ownServer(pidFile, { ...mine, commandOf: () => null }), 4321, 'where the command cannot be read, the live pid is enough');
  fs.writeFileSync(pidFile, 'not a pid');
  assert.equal(ownServer(pidFile, mine), null);
  fs.writeFileSync(pidFile, '1');
  assert.equal(ownServer(pidFile, mine), null, 'never init');
});
