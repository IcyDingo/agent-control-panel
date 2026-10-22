// The hub's configuration and its SQLite database. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadConfig } from '../hub/config.mjs';
import { openDb, SCHEMA_VERSION } from '../hub/db.mjs';

test('config reads the environment with the documented defaults', () => {
  const c = loadConfig({});
  assert.deepEqual([c.port, c.dataDir, c.publicUrl, c.origin, c.host, c.github, c.devLogin, c.trustProxy], [4848, './data', 'http://127.0.0.1:4848', 'http://127.0.0.1:4848', '127.0.0.1:4848', null, false, false]);
  const d = loadConfig({ HUB_PORT: '9000', HUB_PUBLIC_URL: 'https://hub.example.com/', HUB_GITHUB_CLIENT_ID: 'id', HUB_GITHUB_CLIENT_SECRET: 's', HUB_TRUST_PROXY: '1' });
  assert.deepEqual([d.port, d.publicUrl, d.origin, d.host, d.github, d.trustProxy], [9000, 'https://hub.example.com', 'https://hub.example.com', 'hub.example.com', { clientId: 'id', clientSecret: 's' }, true]);
  assert.throws(() => loadConfig({ HUB_PUBLIC_URL: 'https://hub.example.com', HUB_DEV_LOGIN: '1' }), /refused on an https/);
});

test('the database is created with every table, in WAL mode, and opening it again is a no-op', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')), 'data');
  const db = openDb(dir);
  const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((r) => r.name);
  for (const t of ['accounts', 'identities', 'sessions', 'client_tokens', 'device_codes', 'oauth_states', 'systems', 'statuses', 'orders', 'schema_version']) assert.ok(tables.includes(t), t);
  assert.equal(db.prepare('select v from schema_version').get().v, SCHEMA_VERSION);
  assert.equal(db.prepare('pragma journal_mode').get().journal_mode, 'wal');
  db.close();
  assert.equal(openDb(dir).prepare('select v from schema_version').get().v, SCHEMA_VERSION);
  assert.ok(fs.existsSync(path.join(dir, 'hub.sqlite')));
});

test('an in-memory database works, handles ignore case, one account holds a place, and foreign keys are enforced', () => {
  const db = openDb(':memory:');
  const add = db.prepare('insert into accounts (id, ordinal, handle, x, y, created_at) values (?, ?, ?, ?, ?, 0)');
  add.run('a', 1, 'Ada', 0, 0);
  assert.throws(() => add.run('b', 2, 'ada', 1, 1), /UNIQUE/);
  assert.throws(() => add.run('c', 3, 'cy', 0, 0), /UNIQUE/);
  assert.throws(() => db.prepare("insert into sessions (id_hash, account_id, expires_at) values ('h', 'nobody', 1)").run(), /FOREIGN KEY/);
});
