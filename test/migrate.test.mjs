// Agent Panel's folders move across to Glue's once, without losing anything. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateFolders } from '../migrate.mjs';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const read = (f) => fs.readFileSync(f, 'utf8');

test('the old folders move whole when Glue has none', () => {
  const h = home(), sup = path.join(h, 'Library', 'Application Support'), logs = path.join(h, 'Library', 'Logs');
  put(path.join(sup, 'Agent Panel', 'prefs.json'), '{"profile":"work"}');
  put(path.join(sup, 'Agent Panel', 'trust', 'login-x.command'), '#!/bin/zsh');
  put(path.join(logs, 'Agent Panel', 'daemon-4747.log'), 'old log');
  const moved = migrateFolders({ home: h });
  assert.equal(moved.length, 2);
  assert.equal(read(path.join(sup, 'Glue', 'prefs.json')), '{"profile":"work"}');
  assert.equal(read(path.join(sup, 'Glue', 'trust', 'login-x.command')), '#!/bin/zsh');
  assert.equal(read(path.join(logs, 'Glue', 'daemon-4747.log')), 'old log');
  assert.equal(fs.existsSync(path.join(sup, 'Agent Panel')), false);
  assert.equal(fs.existsSync(path.join(logs, 'Agent Panel')), false);
});

test("when both exist, what Glue lacks moves in and Glue's own copy wins", () => {
  const h = home(), sup = path.join(h, 'Library', 'Application Support');
  put(path.join(sup, 'Agent Panel', 'prefs.json'), 'old prefs');
  put(path.join(sup, 'Agent Panel', 'overseer.json'), 'old overseer');
  put(path.join(sup, 'Glue', 'prefs.json'), 'new prefs');
  migrateFolders({ home: h });
  assert.equal(read(path.join(sup, 'Glue', 'prefs.json')), 'new prefs');
  assert.equal(read(path.join(sup, 'Glue', 'overseer.json')), 'old overseer');
  assert.equal(fs.existsSync(path.join(sup, 'Agent Panel', 'prefs.json')), true, 'the old copy that lost stays, not deleted');
});

test('nothing to move is nothing done, and running it again changes nothing', () => {
  const h = home();
  assert.deepEqual(migrateFolders({ home: h }), []);
  put(path.join(h, 'Library', 'Logs', 'Agent Panel', 'a.log'), 'x');
  assert.equal(migrateFolders({ home: h }).length, 1);
  assert.deepEqual(migrateFolders({ home: h }), []);
});

test('a move that fails is left alone and never throws', () => {
  const h = home();
  put(path.join(h, 'Library', 'Logs', 'Agent Panel', 'a.log'), 'x');
  const fsys = { ...fs, renameSync: () => { throw new Error('EPERM'); } };
  assert.deepEqual(migrateFolders({ home: h, fsys }), []);
  assert.equal(fs.existsSync(path.join(h, 'Library', 'Logs', 'Agent Panel', 'a.log')), true);
});
