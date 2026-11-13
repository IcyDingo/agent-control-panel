// The launchd agent that keeps `node server.mjs` running, so the panel holds requests and answers hooks without the app open.
//
// A headless install is one plist in ~/Library/LaunchAgents, loaded into the user's GUI domain: launchd starts the panel
// at login, restarts it when it dies, and logs to ~/Library/Logs/Glue. The label mirrors the app bundle id
// (app/build.sh), so the app and the agent on one port never fight over a name. Everything here is a function of its
// arguments; `run` is how launchctl is called, so tests answer for it and the CLI uses the real one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** The launchd label: `local.glue` on the default port, `local.glue.<port>` on any other. */
export const LABEL = (port) => (port === 4747 ? 'local.glue' : `local.glue.${port}`);

/** The label from before Glue was called Glue. Installing or removing the agent takes away one still loaded under it. */
export const LEGACY_LABEL = (port) => (port === 4747 ? 'local.agent-panel' : `local.agent-panel.${port}`);

/** Where the agent's plist lives. */
export const plistPath = (port, home = os.homedir(), label = LABEL(port)) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);

/** Unloads the agent from before the rename, and deletes its plist, so the two never fight over the port. */
async function removeLegacy({ port, home, run }) {
  const plist = plistPath(port, home, LEGACY_LABEL(port));
  if (!fs.existsSync(plist)) return false;
  await run('launchctl', ['bootout', `${domain()}/${LEGACY_LABEL(port)}`]); // nothing loaded is fine
  try { fs.unlinkSync(plist); } catch {}
  return true;
}

/** Where the server's output goes. */
export const logPath = (port, home = os.homedir()) => path.join(home, 'Library', 'Logs', 'Glue', `daemon-${port}.log`);

/** Runs a command and resolves `{ stdout, stderr, err }`; it never rejects, a failure is in `err`. */
const execRun = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, (err, stdout, stderr) => resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), err: err ?? null }));
});

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const str = (k, v) => `<key>${k}</key><string>${esc(v)}</string>`;

/**
 * The plist XML: run the server from the repo with the given node, PATH and port, keep it alive, log both streams.
 */
export function launchdPlist({ label, node, repo, port, pathEnv, log }) {
  const args = [node, path.join(repo, 'server.mjs')];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    str('Label', label),
    `<key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>`,
    str('WorkingDirectory', repo),
    `<key>EnvironmentVariables</key><dict>${str('PATH', pathEnv)}${str('ACP_PORT', port)}${str('ACP_DAEMON', '1')}</dict>`,
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><true/>',
    '<key>ThrottleInterval</key><integer>10</integer>',
    str('StandardOutPath', log),
    str('StandardErrorPath', log),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const domain = () => `gui/${process.getuid()}`;

/** How many times install tries to load the agent before it gives up. */
const BOOTSTRAP_TRIES = 5;

/**
 * Writes the plist and loads it, replacing any agent already loaded under the label. Throws with launchctl's message if
 * it won't load. `retryMs` is the wait between tries; tests set it to 0.
 */
export async function install({ port, node, repo, pathEnv, home = os.homedir(), run = execRun, retryMs = 500, beforeLoad = () => {} }) {
  const label = LABEL(port), plist = plistPath(port, home), log = logPath(port, home);
  const legacy = await removeLegacy({ port, home, run });
  beforeLoad(); // with the old agent stopped, nothing writes to its folders while they move (cli.mjs)
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(plist, launchdPlist({ label, node, repo, port, pathEnv, log }), { mode: 0o644 });
  await run('launchctl', ['bootout', `${domain()}/${label}`]); // nothing loaded is fine
  // Right after a running agent is booted out, launchd may still be taking it down, and a bootstrap then fails with
  // "5: Input/output error" for a moment. So it tries a few times before it reports the failure.
  let last;
  for (let i = 0; i < BOOTSTRAP_TRIES; i++) {
    if (i) await new Promise((r) => setTimeout(r, retryMs));
    last = await run('launchctl', ['bootstrap', domain(), plist]);
    if (!last.err) return { plist, label, legacy };
  }
  throw new Error(`launchctl bootstrap failed: ${last.stderr.trim() || last.err.message}`);
}

/** Unloads the agent and deletes its plist, and the one from before the rename; `removed` is false when there was none. */
export async function remove({ port, home = os.homedir(), run = execRun }) {
  const legacy = await removeLegacy({ port, home, run });
  await run('launchctl', ['bootout', `${domain()}/${LABEL(port)}`]); // nothing loaded is fine
  try { fs.unlinkSync(plistPath(port, home)); return { removed: true }; } catch { return { removed: legacy }; }
}

/** Whether launchd has the agent loaded, and the pid of the server when it is running. */
export async function status({ port, run = execRun }) {
  const { err, stdout } = await run('launchctl', ['print', `${domain()}/${LABEL(port)}`]);
  if (err) return { loaded: false, pid: null };
  const pid = /^\s*pid = (\d+)/m.exec(stdout)?.[1];
  return { loaded: true, pid: pid ? Number(pid) : null };
}

/** Restarts the loaded agent in place (`kickstart -k` kills it, launchd starts it again). Throws with launchctl's message if it refuses. */
export async function restart({ port, run = execRun }) {
  const r = await run('launchctl', ['kickstart', '-k', `${domain()}/${LABEL(port)}`]);
  if (r.err) throw new Error(`launchctl kickstart failed: ${r.stderr.trim() || r.err.message}`);
  return { label: LABEL(port) };
}
