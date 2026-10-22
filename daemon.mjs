// The launchd agent that keeps `node server.mjs` running, so World keeps growing without the app open.
//
// A headless install is one plist in ~/Library/LaunchAgents, loaded into the user's GUI domain: launchd starts the panel
// at login, restarts it when it dies, and logs to ~/Library/Logs/Agent Panel. The label mirrors the app bundle id
// (app/build.sh), so the app and the agent on one port never fight over a name. Everything here is a function of its
// arguments; `run` is how launchctl is called, so tests answer for it and the CLI uses the real one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** The launchd label: `local.agent-panel` on the default port, `local.agent-panel.<port>` on any other. */
export const LABEL = (port) => (port === 4747 ? 'local.agent-panel' : `local.agent-panel.${port}`);

/** Where the agent's plist lives. */
export const plistPath = (port, home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${LABEL(port)}.plist`);

/** Where the server's output goes. */
export const logPath = (port, home = os.homedir()) => path.join(home, 'Library', 'Logs', 'Agent Panel', `daemon-${port}.log`);

/** Runs a command and resolves `{ stdout, stderr, err }`; it never rejects, a failure is in `err`. */
const execRun = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, (err, stdout, stderr) => resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), err: err ?? null }));
});

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const str = (k, v) => `<key>${k}</key><string>${esc(v)}</string>`;

/** The plist XML: run the server from the repo with the given node, PATH and port, keep it alive, log both streams. */
export function launchdPlist({ label, node, repo, port, pathEnv, log }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    str('Label', label),
    `<key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(path.join(repo, 'server.mjs'))}</string></array>`,
    str('WorkingDirectory', repo),
    `<key>EnvironmentVariables</key><dict>${str('PATH', pathEnv)}${str('ACP_PORT', port)}${str('ACP_DAEMON', '1')}</dict>`,
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><true/>',
    '<key>ThrottleInterval</key><integer>10</integer>',
    str('ProcessType', 'Background'),
    str('StandardOutPath', log),
    str('StandardErrorPath', log),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const domain = () => `gui/${process.getuid()}`;

/** Writes the plist and loads it, replacing any agent already loaded under the label. Throws with launchctl's message if it won't load. */
export async function install({ port, node, repo, pathEnv, home = os.homedir(), run = execRun }) {
  const label = LABEL(port), plist = plistPath(port, home), log = logPath(port, home);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(plist, launchdPlist({ label, node, repo, port, pathEnv, log }), { mode: 0o644 });
  await run('launchctl', ['bootout', `${domain()}/${label}`]); // nothing loaded is fine
  const { err, stderr } = await run('launchctl', ['bootstrap', domain(), plist]);
  if (err) throw new Error(`launchctl bootstrap failed: ${stderr.trim() || err.message}`);
  return { plist, label };
}

/** Unloads the agent and deletes its plist; `removed` is false when there was no plist. */
export async function remove({ port, home = os.homedir(), run = execRun }) {
  await run('launchctl', ['bootout', `${domain()}/${LABEL(port)}`]); // nothing loaded is fine
  try { fs.unlinkSync(plistPath(port, home)); return { removed: true }; } catch { return { removed: false }; }
}

/** Whether launchd has the agent loaded, and the pid of the server when it is running. */
export async function status({ port, run = execRun }) {
  const { err, stdout } = await run('launchctl', ['print', `${domain()}/${LABEL(port)}`]);
  if (err) return { loaded: false, pid: null };
  const pid = /^\s*pid = (\d+)/m.exec(stdout)?.[1];
  return { loaded: true, pid: pid ? Number(pid) : null };
}
