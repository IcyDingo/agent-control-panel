// What the page sees of the app: window.glueApp. It runs sandboxed, before the page's own scripts, and passes
// messages to main.mjs; the page (public/index.html) uses each only when it is there, so a browser misses nothing.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glueApp', {
  /** The shortcut for File › New Agent, shown on the page's button. A browser keeps Ctrl+T for a new tab. */
  newAgent: process.platform === 'darwin' ? '⌘⇧T' : 'Ctrl+Shift+T',
  /** The shortcut for Glue › Settings…, listed under Settings › Keys. */
  settings: process.platform === 'darwin' ? '⌘,' : 'Ctrl+,',
  /** Bring the window forward: a page can't raise a hidden window by itself. */
  focus: () => ipcRenderer.send('glue:focus'),
  /** The desktop's folder dialog, opened at `start`. Resolves like the server's /api/pick-folder. */
  pickFolder: (start) => ipcRenderer.invoke('glue:pick-folder', String(start ?? '')),
  /** The page's theme (dark, light or system), so the title bar matches it. */
  setTheme: (theme) => ipcRenderer.send('glue:theme', String(theme)),
});
