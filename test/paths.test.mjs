import test from 'node:test';
import assert from 'node:assert/strict';
import { dataDir, logDir } from '../paths.mjs';
import { prefsPath } from '../cli.mjs';

test('on a Mac the data and the logs stay where they have always been', () => {
  const at = { platform: 'darwin', env: { XDG_CONFIG_HOME: '/elsewhere', XDG_STATE_HOME: '/elsewhere' }, home: '/Users/x' };
  assert.equal(dataDir(at), '/Users/x/Library/Application Support/Glue');
  assert.equal(logDir(at), '/Users/x/Library/Logs/Glue');
});

test('on Linux they follow the XDG folders, and never make a ~/Library', () => {
  const at = { platform: 'linux', env: {}, home: '/home/x' };
  assert.equal(dataDir(at), '/home/x/.config/glue');
  assert.equal(logDir(at), '/home/x/.local/state/glue');
});

test('XDG_CONFIG_HOME and XDG_STATE_HOME move them, but only when they are absolute paths', () => {
  const moved = { platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/state' }, home: '/home/x' };
  assert.equal(dataDir(moved), '/cfg/glue');
  assert.equal(logDir(moved), '/state/glue');
  const relative = { platform: 'linux', env: { XDG_CONFIG_HOME: 'cfg', XDG_STATE_HOME: '' }, home: '/home/x' };
  assert.equal(dataDir(relative), '/home/x/.config/glue');
  assert.equal(logDir(relative), '/home/x/.local/state/glue');
});

test('the prefs file sits in the data folder unless ACP_PREFS names another', () => {
  const before = process.env.ACP_PREFS;
  try {
    delete process.env.ACP_PREFS;
    assert.equal(prefsPath(), `${dataDir()}/prefs.json`);
    process.env.ACP_PREFS = '/tmp/other/prefs.json';
    assert.equal(prefsPath(), '/tmp/other/prefs.json');
  } finally {
    if (before === undefined) delete process.env.ACP_PREFS; else process.env.ACP_PREFS = before;
  }
});
