// What Settings' first run reads from claude and gh, and the Terminal script that signs you in. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseClaudeAuth, parseGhAuth, claudeLoginCommand, loginScript, LOGIN_ERROR } from '../setup.mjs';

test('a login failure from Claude Code is recognised, other failures are not', () => {
  for (const t of ['Not logged in · Please run /login', 'Invalid API key · Please run /login', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}', 'OAuth token revoked · Please run /login'])
    assert.equal(LOGIN_ERROR.test(t), true, t);
  for (const t of ['Workspace not trusted. Run `claude` in /x once', 'API Error: 529 Overloaded', "The overseer didn't answer in time.", 'spawn claude ENOENT'])
    assert.equal(LOGIN_ERROR.test(t), false, t);
});

test("claude auth status: signed in, with whose account and plan", () => {
  const out = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', orgName: 'Org', subscriptionType: 'max' });
  assert.deepEqual(parseClaudeAuth(out), { state: 'ok', email: 'a@b.c', org: 'Org', plan: 'max', method: 'claude.ai' });
});

test('claude auth status: signed out, or no answer at all', () => {
  assert.deepEqual(parseClaudeAuth(JSON.stringify({ loggedIn: false })), { state: 'signed-out' });
  assert.deepEqual(parseClaudeAuth(''), { state: 'unknown' });
  assert.deepEqual(parseClaudeAuth('Error: timed out'), { state: 'unknown' });
  assert.deepEqual(parseClaudeAuth('null'), { state: 'unknown' });
});

test('claude auth status: an API key sign-in has no email and is still signed in', () => {
  assert.deepEqual(parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: 'api_key' })), { state: 'ok', email: null, org: null, plan: null, method: 'api_key' });
});

test('gh auth status: signed in names the account', () => {
  const stdout = 'github.com\n  ✓ Logged in to github.com account octo-cat (keyring)\n  - Active account: true\n';
  assert.deepEqual(parseGhAuth({ err: null, stdout, stderr: '' }), { state: 'ok', login: 'octo-cat' });
  assert.deepEqual(parseGhAuth({ err: null, stdout: '', stderr: '✓ Logged in to github.com as old-style (oauth_token)' }), { state: 'ok', login: 'old-style' });
});

test('gh auth status: missing, or signed out', () => {
  assert.deepEqual(parseGhAuth({ err: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }), { state: 'missing' });
  assert.deepEqual(parseGhAuth({ err: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }), { state: 'signed-out' });
});

test('the login command names the profile when it is not plain claude', () => {
  assert.equal(claudeLoginCommand({ plain: true, dir: '/Users/x/.claude' }), 'claude auth login');
  assert.equal(claudeLoginCommand({ plain: false, dir: '/Users/x/.claude-work' }), 'CLAUDE_CONFIG_DIR=~/.claude-work claude auth login');
});

test('the login script is valid zsh, on the right profile, and quotes what it is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const scripts = {
    plain: loginScript({ what: 'claude', bin: '/usr/local/bin/claude', configDir: null, label: 'claude' }),
    work: loginScript({ what: 'claude', bin: "/odd path/it's/claude", configDir: '/Users/x/.claude-work', label: 'claude-work' }),
    gh: loginScript({ what: 'gh', bin: '/opt/homebrew/bin/gh', label: 'claude' }),
  };
  assert.match(scripts.plain, /^unset CLAUDE_CONFIG_DIR$/m);
  assert.match(scripts.plain, /^'\/usr\/local\/bin\/claude' auth login$/m);
  assert.match(scripts.work, /^export CLAUDE_CONFIG_DIR='\/Users\/x\/\.claude-work'$/m);
  assert.match(scripts.work, /^'\/odd path\/it'\\''s\/claude' auth login$/m);
  assert.doesNotMatch(scripts.gh, /CLAUDE_CONFIG_DIR/);
  assert.match(scripts.gh, /^'\/opt\/homebrew\/bin\/gh' auth login --hostname github\.com --web$/m);
  for (const [name, text] of Object.entries(scripts)) {
    const f = path.join(dir, name + '.command');
    fs.writeFileSync(f, text);
    execFileSync('zsh', ['-n', f]); // throws on a syntax error
  }
});
