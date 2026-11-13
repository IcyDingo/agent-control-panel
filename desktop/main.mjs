// Glue for Linux: the panel in a window of its own, on Electron. It does what the Mac app does (app/main.swift): starts
// the panel server and keeps it running, shows the count of requests waiting on you, sends other sites to the browser,
// and stays connected when the window is closed. The server runs on Electron's own Node, so nothing but Claude Code
// and python3 has to be installed. What needs no Electron is in lib.mjs, where the tests reach it.
import { app, BrowserWindow, Menu, Tray, Notification, dialog, ipcMain, nativeImage, nativeTheme, screen, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, logDir } from '../paths.mjs';
import { cleanEnv, mergePath, shellPathCommand, parseShellPath, atLeast, waitingCount, isPanelUrl, opensOutside,
  desktopEntry, ownServer } from './lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // the checkout, or resources/app when installed
const LINUX = process.platform === 'linux';
const PORT = Number(process.env.ACP_PORT ?? 4747);
const HOME_URL = `http://127.0.0.1:${PORT}/`;
// ACP_PREFS gives a second panel a folder of its own, as it does the server.
const DATA = process.env.ACP_PREFS ? path.dirname(process.env.ACP_PREFS) : dataDir();
const LOG = path.join(logDir(), `server-${PORT}.log`);
const PID_FILE = path.join(DATA, `server-${PORT}.pid`);
const SETTINGS = path.join(DATA, PORT === 4747 ? 'app' : `app-${PORT}`, 'glue.json');
const ICON = path.join(ROOT, 'app', 'icons', '512x512.png');
const RELEASES = 'https://github.com/IcyDingo/agent-control-panel/releases';
const MIN_CLAUDE = '2.1.303'; // claude agents --json, --bg and claude attach, as the panel uses them (install.sh says the same)
const SMOKE = process.env.ACP_SMOKE === '1'; // the release build's check: load the page, look, quit
const RELOAD_KEY = process.platform === 'darwin' ? '⌘⇧R' : 'Ctrl+Shift+R';

// An ESM main runs its imports before `ready` and nothing else, so these are set here, before the first await.
app.setName('Glue');
app.setPath('userData', path.dirname(SETTINGS)); // Chromium's files, apart from the server's in DATA
if (LINUX) app.setDesktopName('glue.desktop'); // the launcher entry the window and its badge belong to
if (!app.requestSingleInstanceLock()) process.exit(0); // the one already running shows its window (second-instance)

let win = null, tray = null;
let server = null;        // the server process, when this run of the app started it
let adopted = null;       // the pid of one an earlier run started and left behind
let serverStarted = 0, waitingForServer = false, gen = 0, quitting = false, waiting = 0;
let childEnv = cleanEnv(process.env);
let update = null;        // { label, click } once there is a newer version
let updater = null, askedForUpdate = false;

// ---------------------------------------------------------------- settings the app keeps for itself

function settings() { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } }
function saveSettings(change) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SETTINGS, JSON.stringify({ ...settings(), ...change }));
  } catch {}
}

// ---------------------------------------------------------------- the environment

const executable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
const which = (name) => String(childEnv.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, name)).find(executable) ?? null;

/** The login shell's PATH, or null when it doesn't say within three seconds. */
function shellPath() {
  const ask = shellPathCommand(childEnv.SHELL);
  if (!ask) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(ask.cmd, ask.args, { env: childEnv, cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 3000); // and whatever its startup files started
    p.stdout.on('data', (d) => { out = (out + d).slice(-64_000); });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => { clearTimeout(timer); resolve(parseShellPath(out)); });
  });
}

/** PATH as a terminal would have it: an app opened from a launcher gets less, and Claude Code is often in the rest. */
async function resolvePath() {
  const home = os.homedir();
  childEnv.PATH = mergePath(await shellPath(), childEnv.PATH,
    [path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin', '/home/linuxbrew/.linuxbrew/bin', '/opt/homebrew/bin', '/snap/bin']);
}

const run = (cmd, args) => new Promise((resolve) =>
  execFile(cmd, args, { env: childEnv, timeout: 10_000 }, (err, stdout) => resolve({ err, stdout: String(stdout ?? '') })));

/** What is missing before the panel can run, in words, or null when nothing is. */
async function preflight() {
  if (!which('python3')) return 'Glue needs python3, and it isn’t installed. Install it with your package manager (for example: sudo apt install python3).';
  const claude = which('claude');
  if (!claude) return 'Claude Code isn’t installed, or isn’t on your PATH. Install it from https://code.claude.com and check that claude runs in a terminal.';
  const { err, stdout } = await run(claude, ['--version']);
  const version = stdout.trim().split(/\s+/)[0];
  if (!err && version && !atLeast(version, MIN_CLAUDE)) return `Claude Code ${version} is too old: Glue needs ${MIN_CLAUDE} or newer. Run claude update in a terminal.`;
  return null;
}

// ---------------------------------------------------------------- the server

/** Is the panel up on its port? Something else answering there doesn't count. */
async function probe() {
  try {
    const res = await fetch(HOME_URL, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
    return res.status === 200 && (await res.text()).includes('<title>Glue</title>');
  } catch { return false; }
}

/** Show the panel once a server answers on its port, starting one if none does. */
async function connect() {
  if (await probe()) {
    if (server) return show();
    adopted = ownServer(PID_FILE);
    // On Linux a panel this app didn't start is someone else's (another user's, on a shared computer): never shown.
    if (adopted || !LINUX) return show();
    return fail(`Another Glue is already using port ${PORT}: one started by hand, or another user’s on this computer. `
      + 'This app only shows a panel it started itself. Stop that one, or start Glue with ACP_PORT set to another port.', { log: false });
  }
  if (!server) return startServer();
  reconnect();
}

function show() {
  gen += 1;
  waitingForServer = false;
  win?.loadURL(HOME_URL);
}

async function startServer() {
  const missing = await preflight();
  if (missing) return fail(missing, { log: false });
  if (server) return reconnect(); // a second Reload while the first was checking
  let fd;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
    fd = fs.openSync(LOG, 'a');
    fs.writeSync(fd, `\n--- ${new Date().toISOString()} Glue started the server\n`);
  } catch (err) { return fail(`Can’t write the log at ${LOG}: ${err.message}`, { log: false }); }
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: os.homedir(), stdio: ['ignore', fd, fd],
    env: { ...childEnv, ACP_PORT: String(PORT), ELECTRON_RUN_AS_NODE: '1', ...(app.isPackaged ? { ACP_PACKAGED: '1' } : {}) } });
  fs.closeSync(fd);
  p.once('error', (err) => { if (p === server) { server = null; fail(`Couldn’t start the panel server: ${err.message}`); } });
  p.once('exit', (code, signal) => serverExited(p, code, signal));
  server = p;
  adopted = null;
  serverStarted = Date.now();
  try { fs.writeFileSync(PID_FILE, String(p.pid)); } catch {}
  status('Starting the panel server…');
  reconnect();
}

/** Wait for the server to answer, then show the panel. One this app started that doesn't answer in 20 s is reported;
 *  one it was only using that went away is replaced after 8 s. */
function reconnect() {
  gen += 1;
  waitingForServer = true;
  const mine = gen, since = Date.now();
  const step = async () => {
    const up = await probe();
    if (mine !== gen) return;
    if (up) return show();
    const waited = Date.now() - since;
    if (!server && waited >= 8000) return startServer();
    if (server && waited >= 20_000) return fail('The panel server didn’t answer within 20 seconds.');
    setTimeout(() => { if (mine === gen) step(); }, waited < 3000 ? 300 : 1000);
  };
  step();
}

/** While the panel shows, notice its server going away: the page alone would wait for it forever. */
async function watch() {
  if (quitting || waitingForServer || !win || !isPanelUrl(win.webContents.getURL(), PORT)) return;
  if (!(await probe()) && !waitingForServer && !quitting) reconnect();
}

function serverExited(p, code, signal) {
  if (p !== server) return;
  server = null;
  try { fs.unlinkSync(PID_FILE); } catch {}
  if (quitting) return;
  if (Date.now() - serverStarted > 30_000) return startServer(); // it ran a while, then stopped: start it again
  fail(logTail(4000).includes('EADDRINUSE') ? `Something other than the panel is using port ${PORT}.`
    : `The panel server stopped (${signal ?? `exit status ${code}`}).`);
}

/** SIGTERM, so requests it was holding go back to their terminals; SIGKILL if it is still there after 3 s. */
async function stopServer() {
  const pid = server?.pid ?? adopted;
  if (!pid) return;
  const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (const until = Date.now() + 3000; !gone() && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
  if (!gone()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ---------------------------------------------------------------- status pages

function logTail(chars) { try { return fs.readFileSync(LOG, 'utf8').slice(-chars); } catch { return ''; } }
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;');

function status(text, detail = '') {
  win?.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Glue</title>
<style>
  :root { color-scheme: light dark; --bg: #f3f4f6; --fg: #111418; --code: #ffffff; --line: #dfe2e7; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0c0e11; --fg: #e4e8ee; --code: #0f1215; --line: #232830; } }
  body { margin: 0; min-height: 100vh; display: grid; place-content: center; gap: 12px; padding: 32px; box-sizing: border-box;
         background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
  p { margin: 0; max-width: 64ch; }
  pre { margin: 0; max-width: 90vw; max-height: 50vh; overflow: auto; padding: 10px 12px; border: 1px solid var(--line);
        border-radius: 8px; background: var(--code); font: 12px/1.45 ui-monospace, monospace; white-space: pre-wrap; }
</style>
<p>${esc(text)}</p>${detail ? `<pre>${esc(detail)}</pre>` : ''}`));
}

function fail(text, { log = true } = {}) {
  gen += 1;
  waitingForServer = false;
  if (SMOKE) return smokeDone(`${text}\n${logTail(4000)}`);
  const tail = log ? logTail(8000).split('\n').slice(-14).join('\n') : '';
  status(`${text} Press ${RELOAD_KEY} to try again.${log ? ` The server’s log: ${LOG}` : ''}`, tail);
}

// ---------------------------------------------------------------- the window

function savedBounds() {
  const b = settings().bounds, area = screen.getPrimaryDisplay().workArea;
  const onScreen = b && screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 8 && b.y < a.y + a.height - 80);
  if (onScreen) return b;
  const dx = Math.min(80, Math.round(area.width * 0.05)), dy = Math.min(60, Math.round(area.height * 0.05));
  return { x: area.x + dx, y: area.y + dy, width: area.width - 2 * dx, height: area.height - 2 * dy };
}

function makeWindow() {
  win = new BrowserWindow({
    ...savedBounds(), minWidth: 880, minHeight: 560, title: 'Glue', backgroundColor: '#0c0e11', // no white flash before the page paints
    show: !process.argv.includes('--hidden'), ...(LINUX ? { icon: ICON } : {}),
    autoHideMenuBar: true, // the bar stays out of the way and Alt shows it: the only way to the menu where there is no tray
    webPreferences: { preload: path.join(ROOT, 'desktop', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
                      backgroundThrottling: false, spellcheck: false }, // keep the live feed and the count going while hidden
  });
  const wc = win.webContents;
  // Only the panel loads in here. Any other link opens in the default browser.
  wc.setWindowOpenHandler(({ url }) => { if (opensOutside(url)) shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => {
    if (isPanelUrl(url, PORT)) return;
    e.preventDefault();
    if (opensOutside(url)) shell.openExternal(url);
  });
  // The server went away mid-load (a restart): wait for it, then load again.
  wc.on('did-fail-load', (e, code, text, url, mainFrame) => {
    if (!mainFrame || code === -3 || !isPanelUrl(url, PORT) || quitting) return; // -3: a load this app called off itself
    status(`Waiting for the panel server on port ${PORT}…`);
    reconnect();
  });
  wc.on('render-process-gone', () => { if (!quitting) connect(); });
  wc.on('did-finish-load', () => { if (SMOKE && isPanelUrl(wc.getURL(), PORT)) smoke(); });
  win.on('page-title-updated', (e, title) => titled(title));
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    saveSettings({ bounds: win.getNormalBounds() });
    if (quitting || SMOKE) return;
    e.preventDefault(); // closing the window keeps the panel connected, and the count live; Quit ends it
    win.hide();
    if (LINUX && !settings().saidStillRunning) {
      saveSettings({ saidStillRunning: true });
      note('Glue is still running', 'It keeps holding requests while the window is closed. Open Glue again to bring it back; Quit Glue ends it.');
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function note(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, ...(LINUX ? { icon: ICON } : {}) });
  if (onClick) n.on('click', onClick);
  n.show();
}

/** "(3) Glue" → a 3 on the launcher where the desktop shows one, and a flash when a request arrives while you're elsewhere. */
function titled(title) {
  const n = waitingCount(title);
  try { app.setBadgeCount(n); } catch {}
  tray?.setToolTip(n ? `Glue: ${n} waiting on you` : 'Glue');
  if (n > waiting && win && !win.isFocused()) win.flashFrame(true);
  waiting = n;
}

function newAgent() {
  showWindow();
  win?.webContents.executeJavaScript("document.dispatchEvent(new CustomEvent('glue:new-agent'))").catch(() => {});
}

// ---------------------------------------------------------------- page ↔ app

const fromPanel = (e) => isPanelUrl(e.senderFrame?.url ?? '', PORT);
const tilde = (p) => (p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);
const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

ipcMain.on('glue:focus', (e) => { if (fromPanel(e)) showWindow(); });
// The page's theme (dark unless picked otherwise): the title bar follows it. `system` stays the desktop's own.
ipcMain.on('glue:theme', (e, theme) => { if (fromPanel(e) && ['dark', 'light', 'system'].includes(theme)) nativeTheme.themeSource = theme; });
let picking = false;
ipcMain.handle('glue:pick-folder', async (e, start) => {
  if (!fromPanel(e)) return { ok: false, error: 'Not the panel.' };
  if (picking) return { ok: false, error: 'The folder dialog is already open. It may be behind this window.' };
  let from = expand(String(start ?? '').trim()) || os.homedir();
  try { if (!fs.statSync(from).isDirectory()) from = os.homedir(); } catch { from = os.homedir(); }
  picking = true;
  try {
    const r = await dialog.showOpenDialog(win, { title: 'Folder for the new agent', defaultPath: from, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? { ok: false, cancelled: true } : { ok: true, path: tilde(r.filePaths[0]) };
  } catch (err) { return { ok: false, error: err.message }; } finally { picking = false; }
});

// ---------------------------------------------------------------- launcher entries (Linux)

const xdgHome = (name, fallback) => (path.isAbsolute(process.env[name] ?? '') ? process.env[name] : path.join(os.homedir(), ...fallback));
const AUTOSTART = path.join(xdgHome('XDG_CONFIG_HOME', ['.config']), 'autostart', 'glue.desktop');
const MENU_ENTRY = path.join(xdgHome('XDG_DATA_HOME', ['.local', 'share']), 'applications', 'glue.desktop');
const MENU_ICON = path.join(xdgHome('XDG_DATA_HOME', ['.local', 'share']), 'icons', 'hicolor', '512x512', 'apps', 'glue.png');
/** What a launcher runs to open this app: the AppImage file itself, or the installed program. */
const selfPath = () => process.env.APPIMAGE || process.execPath;

function writeEntry(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entry, { mode: 0o755 });
}
function setStartAtLogin(on) {
  try { if (on) writeEntry(AUTOSTART, desktopEntry({ exec: selfPath(), icon: 'glue', autostart: true })); else fs.rmSync(AUTOSTART, { force: true }); }
  catch (err) { dialog.showErrorBox('Start at login', err.message); }
  buildMenu();
}
function addToMenu() {
  try {
    fs.mkdirSync(path.dirname(MENU_ICON), { recursive: true });
    fs.copyFileSync(ICON, MENU_ICON);
    writeEntry(MENU_ENTRY, desktopEntry({ exec: selfPath(), icon: 'glue' }));
    note('Glue is in your applications menu', 'It opens this AppImage from where it is now. Move the file and Glue updates the entry the next time it starts.');
  } catch (err) { dialog.showErrorBox('Add to applications menu', err.message); }
  buildMenu();
}
/** An AppImage can be moved: the entries this app wrote point at where it is now. */
function refreshEntries() {
  if (!LINUX || !app.isPackaged) return;
  for (const [file, autostart] of [[AUTOSTART, true], [MENU_ENTRY, false]]) {
    try {
      const want = desktopEntry({ exec: selfPath(), icon: 'glue', autostart });
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== want) writeEntry(file, want);
    } catch {}
  }
}

// ---------------------------------------------------------------- updates (Linux)

/** An AppImage downloads the new version and offers to restart into it. A .deb is told there is one: installing it
 *  takes the system's password, which is the package manager's to ask for. */
async function setupUpdates() {
  if (!LINUX || !app.isPackaged || SMOKE) return;
  try {
    const { default: pkg } = await import('electron-updater');
    updater = pkg.autoUpdater;
  } catch (err) { console.error('updates:', err.message); return; }
  const appImage = Boolean(process.env.APPIMAGE);
  updater.autoDownload = appImage;
  updater.autoInstallOnAppQuit = appImage;
  updater.on('error', (err) => {
    console.error('updates:', err?.message ?? err);
    if (askedForUpdate) dialog.showMessageBox(win, { type: 'warning', message: 'Couldn’t check for updates', detail: String(err?.message ?? err).slice(0, 400) });
    askedForUpdate = false;
  });
  updater.on('update-not-available', () => {
    if (askedForUpdate) dialog.showMessageBox(win, { type: 'info', message: 'Glue is up to date', detail: `Version ${app.getVersion()}` });
    askedForUpdate = false;
  });
  updater.on('update-available', (info) => {
    askedForUpdate = false;
    if (appImage) return; // it downloads; update-downloaded follows
    const open = () => shell.openExternal(`${RELEASES}/tag/v${info.version}`);
    if (!update) note(`Glue ${info.version} is available`, 'Download the new .deb from the releases page and install it over this one.', open);
    update = { label: `Get Glue ${info.version}…`, click: open };
    buildMenu();
  });
  updater.on('update-downloaded', (info) => {
    if (!update) note(`Glue ${info.version} is ready`, 'Restart Glue to update. Requests it is holding go back to their terminals for a moment.', showWindow);
    update = { label: `Restart to update to ${info.version}`, click: restartToUpdate };
    buildMenu();
  });
  const check = () => updater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 3600_000);
}

/** Stop the server and let go of the single-instance lock first: the new version starts before this one is gone,
 *  and must find neither the port nor the lock taken. */
async function restartToUpdate() {
  quitting = true;
  await stopServer();
  app.releaseSingleInstanceLock();
  updater.quitAndInstall(false, true);
}

// ---------------------------------------------------------------- menu and tray

function buildMenu() {
  const mac = process.platform === 'darwin';
  const linuxItems = !LINUX ? [] : [
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: fs.existsSync(AUTOSTART), enabled: app.isPackaged, click: (item) => setStartAtLogin(item.checked) },
    ...(process.env.APPIMAGE ? [{ label: fs.existsSync(MENU_ENTRY) ? 'Update applications menu entry' : 'Add to applications menu', click: addToMenu }] : []),
    update ?? { label: 'Check for updates…', enabled: Boolean(updater), click: () => { askedForUpdate = true; updater.checkForUpdates().catch(() => {}); } },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Glue', submenu: [
      { label: 'New Agent', accelerator: 'CmdOrCtrl+Shift+T', click: newAgent },
      ...linuxItems,
      { type: 'separator' },
      { label: 'Quit Glue', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ] },
    // On Linux the page handles copy and paste itself, and Ctrl+C in the embedded terminal must reach Claude Code;
    // a menu item with that shortcut would take it. A Mac needs the menu for ⌘C to work at all.
    ...(mac ? [{ role: 'editMenu' }] : []),
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => connect() },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
  ]));
}

function makeTray() {
  if (!LINUX) return; // where the desktop has no tray this shows nothing, and a second launch brings the window back
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }));
    tray.setToolTip('Glue');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Glue', click: showWindow },
      { label: 'New Agent', click: newAgent },
      { type: 'separator' },
      { label: 'Quit Glue', click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
  } catch (err) { console.error('tray:', err.message); }
}

// ---------------------------------------------------------------- the release build's check

let smoked = false;
function smokeDone(problem) {
  if (smoked) return;
  smoked = true;
  if (problem) console.error(`smoke: FAILED\n${problem}`); else console.log('smoke: ok');
  quitting = true;
  stopServer().finally(() => app.exit(problem ? 1 : 0));
}
/** The page loaded: it has the app's bridge, its own title and its own typeface. Then a picture, and out. */
async function smoke() {
  try {
    const seen = await win.webContents.executeJavaScript(`document.fonts.ready.then(() => ({
      bridge: typeof window.glueApp?.pickFolder === 'function' && typeof window.glueApp?.setTheme === 'function',
      shortcut: window.glueApp?.newAgent, title: document.title,
      font: document.fonts.check('14px Geist') && document.fonts.check('12px "Geist Mono"'),
      button: Boolean(document.getElementById('new-agent')?.querySelector('kbd')),
    }))`);
    console.log('smoke:', JSON.stringify(seen));
    const wrong = !seen.bridge ? 'window.glueApp is missing' : !/Glue$/.test(seen.title) ? `the title is ${seen.title}`
      : !seen.font ? 'Geist did not load' : !seen.button ? 'the New agent button shows no shortcut' : null;
    if (process.env.ACP_SMOKE_SHOT) {
      await new Promise((r) => setTimeout(r, 1500)); // the first snapshot, drawn
      fs.writeFileSync(process.env.ACP_SMOKE_SHOT, (await win.webContents.capturePage()).toPNG());
    }
    smokeDone(wrong);
  } catch (err) { smokeDone(err.stack ?? String(err)); }
}

// ---------------------------------------------------------------- start

app.on('second-instance', showWindow);
app.on('activate', showWindow); // a Mac's Dock icon
app.on('window-all-closed', () => {}); // the panel stays connected with no window
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  if (!(server?.pid ?? adopted)) return;
  e.preventDefault();
  stopServer().finally(() => app.quit());
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => app.quit()); // logout: stop the server it started

// Not `await app.whenReady()` here: Electron fires `ready` only once this module has finished loading, so waiting
// for it at the top level would wait forever.
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'; // the page's default theme, until it says otherwise
  buildMenu();
  makeWindow();
  makeTray();
  status('Starting…');
  if (SMOKE) setTimeout(() => smokeDone(`nothing loaded within 60 seconds\n${logTail(4000)}`), 60_000);
  await resolvePath();
  refreshEntries();
  connect();
  setInterval(watch, 4000);
  setupUpdates();
}).catch((err) => { console.error(err); app.exit(1); });
