// The hub's configuration and its SQLite database. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadConfig } from '../hub/config.mjs';
import { openDb, SCHEMA_VERSION } from '../hub/db.mjs';

test('config reads the environment with the documented defaults', () => {
  const c = loadConfig({});
  assert.deepEqual([c.port, c.dataDir, c.publicUrl, c.origin, c.host, c.github, c.devLogin], [4848, './data', 'http://127.0.0.1:4848', 'http://127.0.0.1:4848', '127.0.0.1:4848', null, false]);
  const d = loadConfig({ HUB_PORT: '9000', HUB_PUBLIC_URL: 'https://hub.example.com/', HUB_GITHUB_CLIENT_ID: 'id', HUB_GITHUB_CLIENT_SECRET: 's' });
  assert.deepEqual([d.port, d.publicUrl, d.origin, d.host, d.github], [9000, 'https://hub.example.com', 'https://hub.example.com', 'hub.example.com', { clientId: 'id', clientSecret: 's' }]);
  assert.equal(c.trustProxy, false, 'X-Forwarded-For is ignored unless the hub is told it sits behind a proxy');
  assert.equal(loadConfig({ HUB_TRUST_PROXY: '1' }).trustProxy, true);
  assert.equal(loadConfig({ HUB_TRUST_PROXY: 'yes' }).trustProxy, false, 'only the documented value');
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

test('the indexes the sweeps use exist, an order cannot have an unknown status, and owned rows need their owner', () => {
  const db = openDb(':memory:');
  const indexes = db.prepare("select name, tbl_name, sql from sqlite_master where type = 'index' and sql is not null").all().map((r) => [r.name, r.tbl_name, r.sql.replace(/\s+/g, ' ')]);
  assert.ok(indexes.some(([, t, sql]) => t === 'device_codes' && /\(expires_at\)$/.test(sql)), JSON.stringify(indexes));
  assert.ok(indexes.some(([, t, sql]) => t === 'orders' && /\(status, created_at\)$/.test(sql)), JSON.stringify(indexes));
  db.prepare("insert into accounts (id, ordinal, handle, x, y, created_at) values ('a', 1, 'ada', 0, 0, 0)").run();
  const order = db.prepare("insert into orders (id, account_id, kind, body, status, created_at) values (?, ?, 'frontier', '{}', ?, 0)");
  for (const [i, status] of ['pending', 'running', 'done', 'failed', 'expired'].entries()) order.run(`o${i}`, 'a', status);
  assert.throws(() => order.run('bad', 'a', 'lost'), /CHECK/);
  assert.throws(() => order.run('orphan', null, 'pending'), /NOT NULL/);
  for (const sql of [
    "insert into sessions (id_hash, account_id, expires_at) values ('h', null, 1)",
    "insert into client_tokens (id, hash, account_id) values ('t', 'h', null)",
    "insert into identities (provider, subject, account_id) values ('dev', 'x', null)",
    "insert into systems (account_id, snapshot) values (null, '{}')",
    "insert into statuses (account_id, status, received_at) values (null, '{}', 0)",
  ]) assert.throws(() => db.prepare(sql).run(), /NOT NULL/, sql);
});
