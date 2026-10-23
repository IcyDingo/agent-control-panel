// The hub's copy of each developer's system (the public projection their Mac pushes), the owner-only status beside it
// (balance, prices, today's numbers: served to the owner, never in a public read) and the public view that joins a
// profile to its system. Every snapshot is re-validated and re-serialised here, so what is stored and served is the hub's
// own canonical copy of the shape, never the caller's bytes.
import crypto from 'node:crypto';
import { validProjection, levelName } from '../world.mjs';

/** The versions a Mac may upload: the current one, and the two before it (a Mac not yet updated). */
const UPLOADS = [1, 2, 3];

const fail = (status, error, more = {}) => ({ ok: false, status, error, ...more });
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SYSTEM_REFUSED = 'The system could not be read; nothing was stored.';
const STATUS_REFUSED = 'The status could not be read; nothing was stored.';

/** The owner status as a fresh object (an allow-list copy, key by key), or null when anything is missing or the wrong type. */
function cleanStatus(s) {
  if (!plain(s) || !plain(s.prices) || !plain(s.today) || !plain(s.home) || !plain(s.mac)) return null;
  const { prices, today, home, mac } = s;
  const todayKeys = ['credit', 'commits', 'added', 'removed', 'tokens'];
  const optional = ['multiplier', 'active']; // a Mac from before this release sends the multiplier only; a new one adds the minutes active
  if (!num(s.balance) || typeof s.building !== 'boolean') return null;
  if (!['frontier', 'rocket', 'build'].every((k) => num(prices[k])) || !todayKeys.every((k) => num(today[k]))) return null;
  if (optional.some((k) => today[k] !== undefined && !num(today[k])) || (today.active !== undefined && (today.active < 0 || today.active > 1440))) return null;
  if (prices.probe !== undefined && !num(prices.probe)) return null; // a Mac from before probes leaves it out
  if (!num(home.xp) || !num(home.today)) return null;
  if (typeof mac.name !== 'string' || mac.name.trim().length > 40 || typeof mac.online !== 'boolean') return null;
  return {
    balance: s.balance,
    prices: { frontier: prices.frontier, rocket: prices.rocket, build: prices.build, ...(prices.probe !== undefined && { probe: prices.probe }) },
    today: Object.fromEntries([...todayKeys, ...optional.filter((k) => today[k] !== undefined)].map((k) => [k, today[k]])),
    home: { xp: home.xp, today: home.today },
    building: s.building,
    mac: { name: mac.name.trim(), online: mac.online },
  };
}

export function createSystems(db, { now = Date.now } = {}) {
  const row = (sql, ...args) => db.prepare(sql).get(...args);

  /** Store an upload: `{ pv, seq, device, snapshot }`. An older `seq` is stale (409); the same content is `unchanged`, and
   *  still counts as the Mac being there (the half-hour heartbeat), so it moves `received_at` and the page's last active.
   *  The snapshot is kept in this version, and `pv` as the Mac sent it: what its Mac can run (a push from a colony, a
   *  probe) depends on it. */
  function put(accountId, { pv, seq, device, snapshot } = {}) {
    const clean = UPLOADS.includes(pv) && snapshot?.pv === pv ? validProjection(snapshot) : null;
    if (!clean || !num(seq)) return fail(422, SYSTEM_REFUSED);

    const stored = row('SELECT seq, hash FROM systems WHERE account_id = ?', accountId);
    if (stored && seq < stored.seq) return fail(409, 'stale', { seq: stored.seq });

    const json = JSON.stringify(clean), hash = crypto.createHash('sha256').update(json).digest('hex');
    if (stored && stored.hash === hash) {
      db.prepare('UPDATE systems SET seq = MAX(seq, ?), pv = ?, received_at = ? WHERE account_id = ?').run(seq, pv, now(), accountId);
      return { ok: true, seq: Math.max(seq, stored.seq), hash, unchanged: true };
    }

    const level = clean.home.level;
    db.prepare(`INSERT INTO systems (account_id, pv, seq, hash, device, snapshot, level, stage, days_worked, colonies, builds, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET pv = excluded.pv, seq = excluded.seq, hash = excluded.hash, device = excluded.device,
        snapshot = excluded.snapshot, level = excluded.level, stage = excluded.stage, days_worked = excluded.days_worked,
        colonies = excluded.colonies, builds = excluded.builds, received_at = excluded.received_at`)
      .run(accountId, pv, seq, hash, typeof device === 'string' && device.length <= 100 ? device : null, json,
        level, levelName(level), clean.daysActive, clean.planets.filter((p) => p.colony !== null).length, clean.builds.length, now());
    return { ok: true, seq, hash };
  }

  function get(accountId) {
    const r = row('SELECT * FROM systems WHERE account_id = ?', accountId);
    return !r ? null : {
      snapshot: JSON.parse(r.snapshot), pv: r.pv, level: r.level, stage: r.stage, daysWorked: r.days_worked,
      colonies: r.colonies, builds: r.builds, receivedAt: r.received_at,
    };
  }

  function putStatus(accountId, status) {
    const clean = cleanStatus(status);
    if (!clean) return fail(422, STATUS_REFUSED);
    db.prepare('INSERT INTO statuses (account_id, status, received_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET status = excluded.status, received_at = excluded.received_at')
      .run(accountId, JSON.stringify(clean), now());
    return { ok: true };
  }

  const getStatus = (accountId) => {
    const r = row('SELECT status FROM statuses WHERE account_id = ?', accountId);
    return r ? JSON.parse(r.status) : null;
  };

  /** What a stranger may see of an account: the profile fields, the stats, the system. Built key by key from the account
   *  object and a `get()` result, so nothing else on either (the email, the status, the settings) can reach it. */
  function publicView(account, system) {
    return {
      profile: {
        handle: account.handle, name: account.name, bio: account.bio, link: account.link, avatar: account.avatar,
        x: account.x, y: account.y, joined: day(account.createdAt), visibility: account.visibility,
      },
      stats: system
        ? { level: system.level, stage: system.stage, daysWorked: system.daysWorked, colonies: system.colonies, builds: system.builds, lastActive: day(system.receivedAt), pv: system.pv }
        : { level: 1, stage: levelName(1), daysWorked: 0, colonies: 0, builds: 0, lastActive: null, pv: 0 },
      system: system ? system.snapshot : null,
    };
  }

  return { put, get, putStatus, getStatus, publicView };
}
