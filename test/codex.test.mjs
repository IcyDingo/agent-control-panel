// What Glue reads from OpenAI's Codex CLI, and where each workspace keeps its Codex login. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCodexHomes, codexEnv, codexLoginCommand, findCodex, parseCodexVersion, parseCodexStatus, codexInstallCommand, cleanKey } from '../codex.mjs';

test('an OpenAI login is a Codex home: found on disk, run with CODEX_HOME, signed in with its own command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cxh-'));
  try {
    for (const d of ['.codex', '.codex-work', '.codexy', '.claude']) fs.mkdirSync(path.join(home, d));
    fs.writeFileSync(path.join(home, '.codex-file'), '');
    assert.deepEqual(findCodexHomes(home), [{ provider: 'codex', dir: path.join(home, '.codex'), id: 'codex' },
      { provider: 'codex', dir: path.join(home, '.codex-work'), id: 'codex-work' }]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  assert.deepEqual(codexEnv({ PATH: '/bin' }, '/h/.codex-work'), { PATH: '/bin', CODEX_HOME: '/h/.codex-work' });
  assert.equal(codexLoginCommand('/h/.codex', '/h'), 'codex login');
  assert.equal(codexLoginCommand('/h/.codex-work', '/h'), 'CODEX_HOME=~/.codex-work codex login');
});

test('codex login status: ChatGPT, an API key, signed out, or no answer', () => {
  assert.deepEqual(parseCodexStatus({ stderr: 'Logged in using ChatGPT\n' }), { state: 'ok', method: 'chatgpt' });
  assert.deepEqual(parseCodexStatus({ stdout: 'Logged in using an API key - sk-proj-***abcd\n' }), { state: 'ok', method: 'apikey' });
  assert.deepEqual(parseCodexStatus({ err: new Error('exit 1'), stderr: 'Not logged in\n' }), { state: 'signed-out', method: null });
  assert.deepEqual(parseCodexStatus({ err: Object.assign(new Error('timeout'), { killed: true }) }), { state: 'unknown', method: null });
  assert.deepEqual(parseCodexStatus({}), { state: 'unknown', method: null });
});

test('codex --version gives its version', () => {
  assert.equal(parseCodexVersion('codex-cli 0.169.0\n'), '0.169.0');
  assert.equal(parseCodexVersion('nothing'), null);
});

test('Codex installs with Homebrew where there is one, else with npm', () => {
  assert.deepEqual(codexInstallCommand({ brew: '/opt/homebrew/bin/brew' }), { cmd: "'/opt/homebrew/bin/brew' install codex", show: 'brew install codex' });
  assert.equal(codexInstallCommand({}).show, 'npm install -g @openai/codex');
});

test('the codex binary is found on PATH, and not found when it is not there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-codex-'));
  try {
    assert.equal(findCodex({ home: dir, env: { PATH: dir } }), null);
    fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(findCodex({ home: dir, env: { PATH: dir } }), path.join(dir, 'codex'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an API key is one plain line, or nothing', () => {
  assert.equal(cleanKey('  sk-proj-abcdef123456 \n'), 'sk-proj-abcdef123456');
  for (const bad of ['', 'short', 'sk-a b c d e f', 'sk-abcdefgh\nrm -rf', 42, null, 'x'.repeat(600)]) assert.equal(cleanKey(bad), null, String(bad));
});
