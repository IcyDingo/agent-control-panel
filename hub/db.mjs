// The hub's database. SQLite because the hub is one process with one file to back up, and because the map
// and the chat need real indexes (look up a neighbourhood, page a conversation) that a pile of JSON files can't give.
// `openDb` returns the `DatabaseSync` and every other hub module takes that `db` as an argument: nothing else opens it.
// Schema changes are appended to MIGRATIONS and run in order, once, tracked by the schema_version row.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Index 0 is version 1. Never edit a migration that has shipped; add the next one.
export const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    ordinal INTEGER UNIQUE NOT NULL,
    handle TEXT UNIQUE COLLATE NOCASE NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    name TEXT,
    bio TEXT,
    link TEXT,
    avatar TEXT,
    visibility TEXT NOT NULL DEFAULT 'public',
    show_friends INTEGER NOT NULL DEFAULT 1,
    handle_changed_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(x, y)
  );
  CREATE TABLE identities (
    provider TEXT,
    subject TEXT,
    account_id TEXT REFERENCES accounts(id),
    login TEXT,
    email TEXT,
    avatar TEXT,
    linked_at INTEGER,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX identities_account ON identities(account_id);
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    account_id TEXT REFERENCES accounts(id),
    ua TEXT,
    created_at INTEGER,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_account ON sessions(account_id);
  CREATE TABLE client_tokens (
    id TEXT PRIMARY KEY,
    hash TEXT UNIQUE NOT NULL,
    account_id TEXT REFERENCES accounts(id),
    label TEXT,
    scopes TEXT NOT NULL DEFAULT 'client',
    device TEXT,
    created_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE device_codes (
    hash TEXT PRIMARY KEY,
    user_code TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL,
    interval INTEGER NOT NULL,
    last_poll_at INTEGER,
    status TEXT NOT NULL,
    account_id TEXT,
    token_plain TEXT,
    created_at INTEGER
  );
  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    return_to TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE systems (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    pv INTEGER,
    seq REAL,
    hash TEXT,
    device TEXT,
    snapshot TEXT NOT NULL,
    level INTEGER,
    stage TEXT,
    days_worked INTEGER,
    colonies INTEGER,
    builds INTEGER,
    received_at INTEGER
  );
  CREATE TABLE statuses (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    status TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    account_id TEXT REFERENCES accounts(id),
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    done_at INTEGER,
    result TEXT
  );
  CREATE INDEX orders_pending ON orders(account_id, status);
  CREATE TABLE schema_version (v INTEGER NOT NULL);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// dataDir is a folder (made if missing; the file inside is hub.sqlite) or ':memory:' for a throwaway database.
export function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'hub.sqlite');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  const hasVersion = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  const current = hasVersion ? (db.prepare('SELECT v FROM schema_version').get()?.v ?? 0) : 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    // Each migration and its version bump commit together, so a crash leaves the database at the old version.
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec('DELETE FROM schema_version');
      db.prepare('INSERT INTO schema_version (v) VALUES (?)').run(v + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
