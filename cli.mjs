// The command line behind `node server.mjs daemon install|remove|status | login | logout | status`: it installs the panel as
// a launchd agent, removes it, or says whether it is running; and it signs this Mac in to the hub and out again.
// server.mjs hands any argument to `main` and exits with the code it returns.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LABEL, plistPath, logPath, install, remove, status } from './daemon.mjs';
import { createHub } from './hub.mjs';

const USAGE = 'usage: node server.mjs daemon install|remove|status | login | logout | status';

/** Where this panel keeps its preferences; ACP_PREFS gives a second panel a folder of its own. The hub file lives beside it. */
export const prefsPath = () => process.env.ACP_PREFS || path.join(os.homedir(), 'Library', 'Application Support', 'Agent Panel', 'prefs.json');
const openHub = () => createHub({ file: path.join(path.dirname(prefsPath()), 'hub.json') });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The device sign-in from a terminal: show the code, open the page, and poll at the hub's pace until it ends. */
async function login() {
  const hub = openHub();
  if (hub.status().loggedIn) { const a = hub.status().account; console.log(`Already signed in${a ? ` as @${a.handle}` : ''}. Run \`node server.mjs logout\` first to switch.`); return 0; }
  const r = await hub.startDeviceLogin();
  if (!r.ok) { console.error(r.error); return 1; }
  console.log(`Open ${r.verificationUri} and enter ${r.userCode}`);
  // A browser is a courtesy; without one the line above is enough. Only a web address is handed to `open`, which would
  // as gladly start an app or open a file for anything else the hub sent.
  if (/^https?:\/\//.test(String(r.verificationUri))) execFile('open', [r.verificationUri], () => {});
  for (;;) {
    const p = hub.status().pending;
    await wait((p?.interval ?? 5) * 1000);
    const outcome = await hub.pollDeviceLogin();
    if (outcome === 'ok') {
      const a = hub.status().account;
      console.log(`Signed in as @${a?.handle}. Your galaxy is at ${a?.x}, ${a?.y}.`);
      return 0;
    }
    if (outcome === 'expired') { console.error('That code ran out. Run login again for a new one.'); return 1; }
    if (outcome === 'denied') { console.error('That sign-in was refused on the hub.'); return 1; }
    if (outcome === 'error') { console.error('The sign-in could not be completed. Is the hub reachable?'); return 1; }
  }
}

/** One line for the hub: signed in, waiting for an approval, or neither. */
function hubLine() {
  const s = openHub().status();
  if (s.loggedIn) return `Signed in as @${s.account?.handle} (${s.url})`;
  if (s.pending) return `Waiting for ${s.pending.userCode} to be approved`;
  return `Not signed in (${s.url})`;
}

/** Runs one command and returns the exit code: 0 done, 1 launchctl or the hub refused, 2 the command is not one of ours. */
export async function main(argv) {
  const [cmd, sub] = argv;
  if (cmd === 'login' && argv.length === 1) return login();
  if (cmd === 'logout' && argv.length === 1) {
    const r = await openHub().logout();
    console.log(r.ok ? 'Signed out.' : r.error);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'status' && argv.length === 1) {
    console.log(hubLine());
    return main(['daemon', 'status']);
  }
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
