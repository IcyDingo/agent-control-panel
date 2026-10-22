// Whether a profile trusts a folder, and a Terminal window where you can tell it so.
//
// `claude --bg` only starts in a folder its profile has trusted, and trust is kept per folder (its git root), never
// inherited from a parent. Only you accept it, at Claude Code's own prompt: the panel reads the profile's config to see
// whether you have, and opens Terminal in the folder, on that profile, so the prompt is waiting for you there.

import fs from 'node:fs';
import path from 'node:path';

/** What `claude --bg` says when the folder isn't trusted. Its home-folder message differs: trust there is never kept. */
export const UNTRUSTED = /^Workspace not trusted\. Run `claude` in /;

/** The key Claude Code looks trust up under: the folder's git root, else the folder. */
export const trustKey = (cwd, gitTop) => (gitTop ?? path.resolve(cwd)).normalize('NFC');

/** Whether the profile's config records the folder as trusted; null when the config can't be read. */
export function isTrusted(config, key) {
  try { return JSON.parse(fs.readFileSync(config, 'utf8'))?.projects?.[key]?.hasTrustDialogAccepted === true; } catch { return null; }
}

const sh = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
/** The script Terminal runs: Claude Code in the folder, on the profile, where its trust prompt asks you. */
export const trustScript = ({ dir, configDir, claude, label }) => [
  '#!/bin/zsh',
  `# Opened by Agent Panel: Claude Code asks once whether the ${label} profile trusts this folder.`,
  `cd -- ${sh(dir)} || exit 1`,
  configDir ? `export CLAUDE_CONFIG_DIR=${sh(configDir)}` : 'unset CLAUDE_CONFIG_DIR',
  `exec ${sh(claude)}`,
  '',
].join('\n');
