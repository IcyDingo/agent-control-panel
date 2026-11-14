// OpenAI's Codex CLI, as far as Glue uses it today: is it installed, and is each workspace signed in to it. Agents don't
// run on Codex yet; this is the sign-in that OpenAI has of its own in Settings › Providers › OpenAI. Every Codex call
// and every guess about its output is kept here, as opencode.mjs keeps OpenCode's.
//
// Each workspace has its own Codex home (CODEX_HOME), as it has its own Claude profile: the plain workspace (~/.claude)
// uses Codex's own ~/.codex, any other `~/.codex-<id>`. Codex keeps its login there; Glue keeps nothing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The Codex home a workspace signs in under. `ws` is a profile ({ id, plain }). */
export const codexHome = (ws, home = os.homedir()) => path.join(home, ws.plain ? '.codex' : `.codex-${ws.id}`);

/** The environment Codex runs under for a workspace: its own home, nothing of Claude Code's. */
export const codexEnv = (base, ws, home = os.homedir()) => ({ ...base, CODEX_HOME: codexHome(ws, home) });

/** The command that signs a workspace in to Codex, as you'd type it in a terminal. */
export const codexLoginCommand = (ws) => (ws.plain ? 'codex login' : `CODEX_HOME=~/.codex-${ws.id} codex login`);

/** The codex binary: on PATH, else where Homebrew and npm put it. null when it isn't installed. */
export function findCodex({ home = os.homedir(), env = process.env } = {}) {
  const dirs = [...String(env.PATH ?? '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin',
                path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin')];
  for (const d of dirs) {
    const f = path.join(d, 'codex');
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

/** `codex --version` says `codex-cli 0.169.0`: the version, or null. */
export function parseCodexVersion(text) {
  return String(text ?? '').match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] ?? null;
}

/**
 * `codex login status` says how a home is signed in, on stderr or stdout depending on the version, and exits non-zero
 * when it isn't: "Logged in using ChatGPT", "Logged in using an API key - sk-…", "Not logged in".
 * @returns {{ state: 'ok'|'signed-out'|'unknown', method: 'chatgpt'|'apikey'|null }}
 */
export function parseCodexStatus({ err, stdout = '', stderr = '' } = {}) {
  const text = `${stdout}\n${stderr}`;
  if (/logged in using chatgpt/i.test(text)) return { state: 'ok', method: 'chatgpt' };
  if (/logged in using (?:an )?api key/i.test(text)) return { state: 'ok', method: 'apikey' };
  if (/not logged in/i.test(text)) return { state: 'signed-out', method: null };
  if (/logged in/i.test(text) && !err) return { state: 'ok', method: null };
  return { state: err?.killed ? 'unknown' : err ? 'signed-out' : 'unknown', method: null };
}

/** How Codex installs here: Homebrew when this computer has it, else npm. `brew` is its path or null. */
export function codexInstallCommand({ brew = null } = {}) {
  return brew ? { cmd: `'${brew.replace(/'/g, `'\\''`)}' install codex`, show: 'brew install codex' }
    : { cmd: 'npm install -g @openai/codex', show: 'npm install -g @openai/codex' };
}

/** An API key as Codex takes it on stdin: one line, nothing that could be another argument or another line. */
export function cleanKey(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  return k.length >= 8 && k.length <= 512 && /^[\x21-\x7e]+$/.test(k) ? k : null;
}
