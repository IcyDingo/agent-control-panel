// The hub's accounts: signing in (an identity from GitHub or the dev login finds or creates an account), the permanent spot
// and handle each account gets, and the profile an account may edit. All SQL for accounts and identities lives here so the
// rules (a handle is unique and changes once a week, a spot is never reused) have one home.
import crypto from 'node:crypto';
import { placeOf } from './coords.mjs';
import { handle as cleanHandle, optionalText, link as cleanLink } from './validate.mjs';

const WEEK = 7 * 24 * 3600 * 1000;
const AVATAR_PREFIX = 'https://avatars.githubusercontent.com/';

const toAccount = (r) => !r ? null : {
  id: r.id, ordinal: r.ordinal, handle: r.handle, x: r.x, y: r.y, name: r.name, bio: r.bio, link: r.link,
  avatar: r.avatar, visibility: r.visibility, showFriends: !!r.show_friends, createdAt: r.created_at,
};
const fail = (status, error) => ({ ok: false, status, error });

export function createAccounts(db, { now = Date.now, random = crypto.randomUUID } = {}) {
  const row = (sql, ...args) => db.prepare(sql).get(...args);
  const byId = (id) => toAccount(row('SELECT * FROM accounts WHERE id = ?', id));
  const byHandle = (h) => toAccount(row('SELECT * FROM accounts WHERE handle = ?', String(h))); // the column is NOCASE
  const byCoords = (x, y) => toAccount(row('SELECT * FROM accounts WHERE x = ? AND y = ?', x, y));

  /** The account behind this provider identity (made on the first sign-in). */
  function signIn({ provider, subject, login, avatar, email }) {
    const known = row('SELECT account_id FROM identities WHERE provider = ? AND subject = ?', provider, subject);
    if (known) return { account: byId(known.account_id), created: false };

    db.exec('BEGIN');
    try {
      const ordinal = (row('SELECT MAX(ordinal) AS n FROM accounts').n ?? 0) + 1;
      const { x, y } = placeOf(ordinal);
      const wanted = cleanHandle(login);
      const taken = wanted && row('SELECT 1 FROM accounts WHERE handle = ?', wanted);
      const chosen = wanted && !taken ? wanted : `${wanted ?? 'dev'}-${ordinal}`;
      const picture = typeof avatar === 'string' && avatar.startsWith(AVATAR_PREFIX) ? avatar : null;
      const id = random(), t = now();
      db.prepare('INSERT INTO accounts (id, ordinal, handle, x, y, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, ordinal, chosen, x, y, picture, t);
      db.prepare('INSERT INTO identities (provider, subject, account_id, login, email, avatar, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(provider, subject, id, login ?? null, email ?? null, picture, t);
      db.exec('COMMIT');
      return { account: byId(id), created: true };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Apply the editable fields present in `fields`; all are checked before any is written. */
  function updateProfile(id, fields = {}) {
    const current = byId(id);
    if (!current) return fail(404, 'No such account.');
    const set = {};

    for (const [key, max, label] of [['name', 40, 'name'], ['bio', 160, 'bio']]) {
      if (fields[key] === undefined) continue;
      const v = optionalText(fields[key], max);
      if (v === null) return fail(422, `The ${label} is not valid (up to ${max} characters).`);
      set[key] = v;
    }
    if (fields.link !== undefined) {
      const v = cleanLink(fields.link);
      if (v === null) return fail(422, 'The link must be an http or https address of up to 200 characters.');
      set.link = v;
    }
    if (fields.visibility !== undefined) {
      if (fields.visibility !== 'public' && fields.visibility !== 'unlisted') return fail(422, 'Visibility is public or unlisted.');
      set.visibility = fields.visibility;
    }
    if (fields.showFriends !== undefined) set.show_friends = fields.showFriends ? 1 : 0;

    if (fields.handle !== undefined) {
      const h = cleanHandle(fields.handle);
      if (h === null) return fail(422, "That handle isn't allowed.");
      if (h !== current.handle.toLowerCase()) {
        const owner = row('SELECT id FROM accounts WHERE handle = ?', h);
        if (owner && owner.id !== id) return fail(409, 'That handle is taken.');
        const changedAt = row('SELECT handle_changed_at AS t FROM accounts WHERE id = ?', id).t;
        if (changedAt !== null && now() - changedAt < WEEK) return fail(409, 'A handle changes at most once a week.');
        set.handle = h;
        set.handle_changed_at = now();
      }
    }

    const cols = Object.keys(set);
    if (cols.length) {
      db.prepare(`UPDATE accounts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), id);
    }
    return { ok: true, account: byId(id) };
  }

  const identitiesOf = (id) => db.prepare('SELECT provider, login FROM identities WHERE account_id = ? ORDER BY linked_at, rowid').all(id)
    .map((r) => ({ provider: r.provider, login: r.login }));

  return { signIn, byId, byHandle, byCoords, updateProfile, identitiesOf };
}
