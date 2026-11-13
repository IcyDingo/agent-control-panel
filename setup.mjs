// First-run setup: what the checklist on the overseer's page says about the accounts the panel borrows.
//
// The panel has no login of its own. It runs on the profile's Claude Code login (the overseer, new agents) and on your
// own `gh` (the GitHub panel, the PR watcher). These read what each says about itself, and write the Terminal script
// that signs you in, so the browser never handles a password or a token.

const sh = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/**
 * What `claude auth status --json` says. `unknown` when it didn't answer with JSON (not installed, timed out).
 * @returns {{state: 'ok'|'signed-out'|'unknown', email?: string|null, org?: string|null, plan?: string|null, method?: string|null}}
 */
export function parseClaudeAuth(stdout) {
  let a;
  try { a = JSON.parse(String(stdout ?? '')); } catch { return { state: 'unknown' }; }
  if (!a || typeof a !== 'object') return { state: 'unknown' };
  if (!a.loggedIn) return { state: 'signed-out' };
  return { state: 'ok', email: a.email ?? null, org: a.orgName ?? null, plan: a.subscriptionType ?? null, method: a.authMethod ?? null };
}

/**
 * What `gh auth status --hostname github.com` says, from how it ended: gh missing (the spawn fails with ENOENT),
 * signed out (it exits non-zero), or signed in, with the account it names.
 * @returns {{state: 'ok'|'signed-out'|'missing', login?: string|null}}
 */
export function parseGhAuth({ err, stdout, stderr } = {}) {
  if (err?.code === 'ENOENT') return { state: 'missing' };
  const text = `${stdout ?? ''}\n${stderr ?? ''}`;
  if (err) return { state: 'signed-out' };
  const m = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(text);
  return { state: 'ok', login: m?.[1] ?? null };
}

/**
 * Whether a failure from Claude Code reads as a missing or lapsed login, so the panel looks again and shows its sign-in
 * banner rather than leaving only the raw message. Matched loosely: a false match costs one `claude auth status`.
 */
export const LOGIN_ERROR = /not logged in|run \/login|invalid api key|oauth token (?:has )?expired|token (?:has been )?revoked|authentication_error|not signed in/i;

/** The command that signs a profile in to Claude Code, as you'd type it in a terminal. */
export const claudeLoginCommand = (p) => (p.plain ? 'claude auth login' : `CLAUDE_CONFIG_DIR=~/${p.dir.split('/').pop()} claude auth login`);

/**
 * The script Terminal runs to sign you in: Claude Code's own login on the profile, or gh's. It waits for a key at the
 * end, so what happened stays readable, and says to go back to the panel, which notices by itself.
 */
export const loginScript = ({ what, bin, configDir, label }) => [
  '#!/bin/zsh',
  what === 'claude'
    ? `# Opened by Agent Panel: sign the ${label} profile in to Claude Code.`
    : '# Opened by Agent Panel: sign the GitHub CLI in to github.com.',
  what === 'claude' ? (configDir ? `export CLAUDE_CONFIG_DIR=${sh(configDir)}` : 'unset CLAUDE_CONFIG_DIR') : null,
  what === 'claude' ? `${sh(bin)} auth login` : `${sh(bin)} auth login --hostname github.com --web`,
  'echo',
  'echo "Go back to Agent Panel: it notices by itself. Press any key to close this window."',
  'read -k 1 -s',
  '',
].filter((l) => l != null).join('\n');
