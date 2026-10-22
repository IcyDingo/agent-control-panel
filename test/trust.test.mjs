// Whether a profile trusts a folder, and the Terminal script that lets you tell it so. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { UNTRUSTED, trustKey, isTrusted, trustScript } from '../trust.mjs';

test("Claude Code's message for a folder it hasn't trusted is recognised", () => {
  assert.equal(UNTRUSTED.test('Workspace not trusted. Run `claude` in /Users/someone/code/app once and accept the trust prompt, then retry.'), true);
  assert.equal(UNTRUSTED.test('Workspace not trusted. The home directory is trusted one session at a time; start this from an interactive terminal there, or from a project directory.'), false, 'home: trusting it would not stick');
  assert.equal(UNTRUSTED.test('Not logged in. Run claude to sign in.'), false);
});

test('a folder is looked up under its git root, else itself, as Claude Code does', () => {
  assert.equal(trustKey('/a/b/c', '/a/b'), '/a/b');
  assert.equal(trustKey('/a/b/../c', null), '/a/c');
  assert.equal(trustKey('/a/Café', null), '/a/Café');
});

test("the profile's config says whether it trusts the folder", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trust-')), '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ projects: { '/yes': { hasTrustDialogAccepted: true }, '/no': { hasTrustDialogAccepted: false } } }, null, 2));
  assert.equal(isTrusted(file, '/yes'), true);
  assert.equal(isTrusted(file, '/no'), false);
  assert.equal(isTrusted(file, '/never-seen'), false);
  assert.equal(isTrusted(file + '.missing', '/yes'), null, "a config it can't read says nothing either way");
  fs.writeFileSync(file, '{"projects": {');
  assert.equal(isTrusted(file, '/yes'), null);
});

test('the Terminal script runs Claude Code in the folder, on the profile, whatever the folder is called', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it's a folder "));
  const fake = path.join(dir, 'fake claude');
  fs.writeFileSync(fake, '#!/bin/sh\necho "$PWD|${CLAUDE_CONFIG_DIR-unset}"\n', { mode: 0o755 });
  const run = (configDir) => {
    const script = path.join(dir, 'trust.command');
    fs.writeFileSync(script, trustScript({ dir, configDir, claude: fake, label: 'claude-x' }), { mode: 0o700 });
    return execFileSync('/bin/zsh', [script], { env: { ...process.env, CLAUDE_CONFIG_DIR: '/from/your/shell' }, encoding: 'utf8' }).trim();
  };
  assert.equal(run("/Users/someone/.claude-x's"), `${dir}|/Users/someone/.claude-x's`);
  assert.equal(run(null), `${dir}|unset`, 'the plain profile: not one your shell happens to set');
  assert.match(trustScript({ dir: '/a', configDir: null, claude: '/c', label: 'claude' }), /^#!\/bin\/zsh\n# Opened by Agent Panel/);
});
