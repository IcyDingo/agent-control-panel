// The command line behind `node server.mjs daemon install|remove|status | status`: it installs the panel as a launchd
// agent, removes it, or says whether it is running. server.mjs hands any argument to `main` and exits with the code it
// returns.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL, plistPath, logPath, install, remove, status } from './daemon.mjs';
import { migrateFolders } from './migrate.mjs';
import { dataDir } from './paths.mjs';

const USAGE = 'usage: node server.mjs daemon install|remove|status | status';

/** Where this panel keeps its preferences; ACP_PREFS gives a second panel a folder of its own. */
export const prefsPath = () => process.env.ACP_PREFS || path.join(dataDir(), 'prefs.json');

/** Runs one command and returns the exit code: 0 done, 1 launchctl refused, 2 the command is not one of ours. */
export async function main(argv, { platform = process.platform } = {}) {
  const [cmd, sub] = argv;
  if (cmd === 'status' && argv.length === 1) return main(['daemon', 'status'], { platform });
  if (cmd !== 'daemon' || argv.length !== 2 || !['install', 'remove', 'status'].includes(sub)) { console.error(USAGE); return 2; }
  // The service is a launchd agent. On Linux the app keeps the panel running, and starts with you when asked to.
  if (platform !== 'darwin') { console.error('The background service is for macOS. On Linux, turn on Start at login in the Glue app.'); return 1; }
  const port = Number(process.env.ACP_PORT ?? 4747);
  try {
    if (sub === 'install') {
      const repo = path.dirname(fileURLToPath(import.meta.url));
      // process.execPath is the resolved binary, which under Homebrew is a versioned Cellar path that a `brew upgrade`
      // deletes. install.sh passes the node on PATH as ACP_NODE, a link that keeps working across upgrades.
      const node = process.env.ACP_NODE || process.execPath;
      // Agent Panel's folders move to Glue's once its old agent is stopped, before Glue's starts and reads them.
      const beforeLoad = () => { if (!process.env.ACP_PREFS) for (const [a, b] of migrateFolders({ home: os.homedir() })) console.log(`Moved ${a} to ${b}`); };
      const { label, legacy } = await install({ port, node, repo, pathEnv: process.env.PATH ?? '', beforeLoad });
      if (legacy) console.log('Removed the background service from before the rename (local.agent-panel)');
      console.log(`Background service ${label} installed (log: ${logPath(port)})`);
    } else if (sub === 'remove') {
      const { removed } = await remove({ port });
      console.log(removed ? 'Background service removed' : 'No background service was installed');
    } else {
      const { pid } = await status({ port });
      console.log(pid ? `Running (pid ${pid})` : fs.existsSync(plistPath(port)) ? 'Installed, not running' : 'Not installed');
    }
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}
