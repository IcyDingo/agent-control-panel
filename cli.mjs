// The command line behind `node server.mjs daemon install|remove|status`: it installs the panel as a launchd agent,
// removes it, or says whether it is running. server.mjs hands any argument to `main` and exits with the code it returns.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL, plistPath, logPath, install, remove, status } from './daemon.mjs';

const USAGE = 'usage: node server.mjs daemon install|remove|status';

/** Runs one command and returns the exit code: 0 done, 1 launchctl refused, 2 the command is not one of ours. */
export async function main(argv) {
  const [cmd, sub] = argv;
  if (cmd !== 'daemon' || !['install', 'remove', 'status'].includes(sub)) { console.error(USAGE); return 2; }
  const port = Number(process.env.ACP_PORT ?? 4747);
  try {
    if (sub === 'install') {
      const repo = path.dirname(fileURLToPath(import.meta.url));
      // process.execPath is the resolved binary, which under Homebrew is a versioned Cellar path that a `brew upgrade`
      // deletes. install.sh passes the node on PATH as ACP_NODE, a link that keeps working across upgrades.
      const node = process.env.ACP_NODE || process.execPath;
      const { label } = await install({ port, node, repo, pathEnv: process.env.PATH ?? '' });
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
