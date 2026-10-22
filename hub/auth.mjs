// The hub's proof of who is calling: browser sessions, the client tokens the desktop app holds, the device flow that
// hands the app one, and the short-lived state that guards the GitHub redirect. Every secret (a session id, a token, a
// device code) is stored only as its sha256, so a copy of the database cannot be used to sign in. The one exception is
// a token approved for a device that has not collected it yet: it waits in device_codes.token_plain until the single
// poll that picks it up, then the column is cleared.
import crypto from 'node:crypto';

const DAY = 24 * 3600 * 1000;
const SESSION_TTL_MS = 30 * DAY;
const STATE_TTL_MS = 10 * 60 * 1000;
const USED_BUMP_MS = 60 * 1000; // a token's last_used_at moves at most this often, so busy clients don't write on every call
export const DEVICE_TTL_MS = 900_000;
export const DEVICE_INTERVAL_S = 5;
const SLOW_DOWN_BY_S = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'; // no vowels (no accidental words) and no 0/1/O/I (no misreading)

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64url = (buf) => buf.toString('base64url');

/** A post-sign-in destination that can never leave the hub: a path on this origin, or null. Browsers drop tabs and newlines
 *  and read a backslash as a slash, so `/\evil.example` and `/<tab>/evil.example` would otherwise be off-site; anything with a
 *  backslash or control character is refused, and the rest must still resolve to the same origin. */
function localPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(p)) return null;
  try {
    const u = new URL(p, 'http://local.invalid');
    return u.origin === 'http://local.invalid' ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

/** What the user typed, folded to the stored `XXXX-XXXX` shape (case and the dash don't matter); null if it can't be one. */
function normalizeUserCode(input) {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}

export function createAuth(db, { now = Date.now, randomBytes = crypto.randomBytes } = {}) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const secret = () => b64url(randomBytes(32));

  // ---- Sessions ----

  function createSession(accountId, ua = '') {
    const id = secret(), t = now();
    run('INSERT INTO sessions (id_hash, account_id, ua, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256(id), accountId, String(ua).slice(0, 200), t, t + SESSION_TTL_MS);
    return id;
  }

  function sessionAccountId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const r = one('SELECT account_id, expires_at FROM sessions WHERE id_hash = ?', sha256(sessionId));
    return r && now() < r.expires_at ? r.account_id : null;
  }

  function deleteSession(sessionId) {
    run('DELETE FROM sessions WHERE id_hash = ?', sha256(sessionId));
  }

  // ---- Client tokens ----

  function mintToken(accountId, { label = null, device = null } = {}) {
    const token = `hub_${secret()}`, id = b64url(randomBytes(9));
    run('INSERT INTO client_tokens (id, hash, account_id, label, scopes, device, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      id, sha256(token), accountId, label, 'client', device, now());
    return { id, token };
  }

  function tokenAccountId(token) {
    if (typeof token !== 'string' || !token) return null;
    const r = one('SELECT id, account_id, last_used_at, revoked_at FROM client_tokens WHERE hash = ?', sha256(token));
    if (!r || r.revoked_at !== null) return null;
    const t = now();
    if (r.last_used_at === null || t - r.last_used_at >= USED_BUMP_MS) run('UPDATE client_tokens SET last_used_at = ? WHERE id = ?', t, r.id);
    return r.account_id;
  }

  const listTokens = (accountId) => db.prepare(
    'SELECT id, label, device, created_at, last_used_at FROM client_tokens WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid',
  ).all(accountId).map((r) => ({ id: r.id, label: r.label, device: r.device, createdAt: r.created_at, lastUsedAt: r.last_used_at }));

  const revokeToken = (accountId, id) =>
    run('UPDATE client_tokens SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL', now(), String(id), accountId).changes > 0;

  const revokeByToken = (token) =>
    run('UPDATE client_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL', now(), sha256(token)).changes > 0;

  // ---- The device flow: the app shows a short code, the user approves it on the website, the app polls for its token ----

  /** Eight characters from the alphabet; bytes at or above the largest multiple of its length are skipped so no letter is likelier. */
  function userCode() {
    const n = USER_CODE_ALPHABET.length, limit = 256 - (256 % n);
    let out = '';
    while (out.length < 8) {
      for (const b of randomBytes(16)) {
        if (b < limit && out.length < 8) out += USER_CODE_ALPHABET[b % n];
      }
    }
    return `${out.slice(0, 4)}-${out.slice(4)}`;
  }

  /** A code that ran out: it is expired for good, and if it was approved but never collected, the token minted for it is
   *  revoked and the parked plain text dropped, so no live token is left that nobody holds. */
  function expireDevice(r) {
    db.exec('BEGIN');
    try {
      if (r.token_plain) run('UPDATE client_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL', now(), sha256(r.token_plain));
      run("UPDATE device_codes SET status = 'expired', token_plain = NULL WHERE hash = ?", r.hash);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function startDevice() {
    const deviceCode = secret(), t = now();
    // Sweep: expire what ran out unnoticed (an approval nobody came back for), and forget rows long past their end.
    for (const r of db.prepare("SELECT hash, token_plain FROM device_codes WHERE status != 'expired' AND status != 'used' AND expires_at <= ?").all(t)) expireDevice(r);
    run('DELETE FROM device_codes WHERE expires_at <= ?', t - DAY);
    for (;;) {
      const code = userCode();
      if (one('SELECT 1 FROM device_codes WHERE user_code = ?', code)) continue;
      run('INSERT INTO device_codes (hash, user_code, expires_at, interval, last_poll_at, status, account_id, token_plain, created_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?)',
        sha256(deviceCode), code, t + DEVICE_TTL_MS, DEVICE_INTERVAL_S, 'pending', t);
      return { device_code: deviceCode, user_code: code, expires_in: DEVICE_TTL_MS / 1000, interval: DEVICE_INTERVAL_S };
    }
  }

  /** The row for a typed user code, only while it is still waiting for a decision. */
  function pendingByUserCode(input) {
    const code = normalizeUserCode(input);
    const r = code && one('SELECT hash, user_code, expires_at, status FROM device_codes WHERE user_code = ?', code);
    return r && r.status === 'pending' && now() < r.expires_at ? r : null;
  }

  function approveDevice(userCodeInput, accountId, label) {
    const r = pendingByUserCode(userCodeInput);
    if (!r) return { ok: false, error: 'That code is not valid or has expired.' };
    db.exec('BEGIN');
    try {
      const { token } = mintToken(accountId, { label, device: r.user_code });
      run("UPDATE device_codes SET status = 'approved', account_id = ?, token_plain = ? WHERE hash = ?", accountId, token, r.hash);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true };
  }

  function denyDevice(userCodeInput) {
    const r = pendingByUserCode(userCodeInput);
    if (!r) return { ok: false, error: 'That code is not valid or has expired.' };
    run("UPDATE device_codes SET status = 'denied' WHERE hash = ?", r.hash);
    return { ok: true };
  }

  function pollDevice(deviceCode) {
    if (typeof deviceCode !== 'string' || !deviceCode) return { status: 'unknown' };
    const hash = sha256(deviceCode);
    const r = one('SELECT * FROM device_codes WHERE hash = ?', hash);
    if (!r) return { status: 'unknown' };
    const t = now();

    if (r.status === 'used' || r.status === 'expired') return { status: 'expired' };
    if (t >= r.expires_at) {
      expireDevice(r);
      return { status: 'expired' };
    }

    // Polling faster than the interval is told to slow down, and the interval grows. Every poll counts as the last one.
    const tooFast = r.last_poll_at !== null && t - r.last_poll_at < r.interval * 1000;
    run('UPDATE device_codes SET last_poll_at = ?, interval = ? WHERE hash = ?', t, tooFast ? r.interval + SLOW_DOWN_BY_S : r.interval, hash);
    if (tooFast) return { status: 'slow_down' };

    if (r.status === 'denied') return { status: 'denied' };
    if (r.status === 'approved') {
      run("UPDATE device_codes SET status = 'used', token_plain = NULL WHERE hash = ?", hash);
      return { status: 'ok', token: r.token_plain, accountId: r.account_id };
    }
    return { status: 'pending' };
  }

  // ---- OAuth state: ties the GitHub redirect back to the browser that started it ----

  function newState(returnTo) {
    const state = secret(), t = now();
    run('DELETE FROM oauth_states WHERE expires_at <= ?', t); // keep the table small
    run('INSERT INTO oauth_states (state, return_to, expires_at) VALUES (?, ?, ?)', state, localPath(returnTo), t + STATE_TTL_MS);
    return state;
  }

  function takeState(state) {
    if (typeof state !== 'string' || !state) return null;
    const r = one('SELECT return_to, expires_at FROM oauth_states WHERE state = ?', state);
    if (!r) return null;
    run('DELETE FROM oauth_states WHERE state = ?', state);
    return now() < r.expires_at ? { returnTo: r.return_to } : null;
  }

  return {
    createSession, sessionAccountId, deleteSession,
    mintToken, tokenAccountId, listTokens, revokeToken, revokeByToken,
    startDevice, approveDevice, denyDevice, pollDevice,
    newState, takeState,
  };
}
