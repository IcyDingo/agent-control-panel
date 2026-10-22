// The orders an owner places on the site and their Mac executes: a push of the frontier, a rocket, a build, a probe. The hub only
// checks the shape and keeps the queue (one order out per account, 24 hours to land); the Mac does the buying. An order
// goes pending → running when a Mac claims it, and only the Mac that claimed it runs it, so two Macs signed in to one
// account never both buy the same thing; then done or failed, or expired if it never landed.
import crypto from 'node:crypto';
import { colonyName } from '../world.mjs';

export const ORDER_TTL_MS = 86_400_000;
// A claimed order that has not landed an hour later belongs to a Mac that went away (a build is capped at 120 s).
export const RUNNING_TTL_MS = 60 * 60 * 1000;
const PLANET = /^p\d{1,4}$/;
const fail = (status, error) => ({ ok: false, status, error });

/** The fields an order of this kind keeps, as a fresh object, or null when the body isn't a well-formed one. */
function cleanBody(b) {
  if (b === null || typeof b !== 'object') return null;
  const ang = typeof b.ang === 'number' && Number.isFinite(b.ang) ? b.ang : null;
  if (b.kind === 'frontier') { // from Home, or a colony the Mac checks
    if (ang === null || (b.from !== undefined && !(b.from === 'home' || (typeof b.from === 'string' && PLANET.test(b.from))))) return null;
    return b.from === undefined ? { ang } : { ang, from: b.from };
  }
  if (b.kind === 'probe') return ang === null ? null : { ang };
  if (b.kind === 'rocket') {
    const name = colonyName(b.name);
    return typeof b.planet === 'string' && PLANET.test(b.planet) && name !== null ? { planet: b.planet, name } : null;
  }
  if (b.kind === 'build') {
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    const on = typeof b.on === 'string' && (b.on === 'home' || PLANET.test(b.on)) ? b.on : null;
    return on !== null && description !== '' && description.length <= 300 ? { on, description } : null;
  }
  return null;
}

const text300 = (v) => (typeof v === 'string' ? v.slice(0, 300) : undefined);

export function createOrders(db, { now = Date.now, random = crypto.randomUUID } = {}) {
  const toOrder = (r) => ({ id: r.id, kind: r.kind, ...JSON.parse(r.body), status: r.status, createdAt: r.created_at });

  /** Orders older than the TTL stop waiting, and so does one claimed an hour ago by a Mac that never said how it went, so
   *  the account can order again; returns how many. */
  function expire(t = now()) {
    return Number(db.prepare(`UPDATE orders SET status = 'expired' WHERE (status IN ('pending', 'running') AND created_at + ? <= ?)
      OR (status = 'running' AND claimed_at + ? <= ?)`).run(ORDER_TTL_MS, t, RUNNING_TTL_MS, t).changes);
  }

  function place(accountId, body) {
    const fields = cleanBody(body);
    if (!fields) return fail(422, 'That order could not be read; nothing was placed.');
    db.exec('BEGIN');
    try {
      expire();
      if (db.prepare("SELECT 1 FROM orders WHERE account_id = ? AND status IN ('pending', 'running')").get(accountId)) {
        db.exec('ROLLBACK');
        return fail(409, "One thing at a time: the last order hasn't landed yet.");
      }
      const id = random(), createdAt = now();
      db.prepare("INSERT INTO orders (id, account_id, kind, body, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
        .run(id, accountId, body.kind, JSON.stringify(fields), createdAt);
      db.exec('COMMIT');
      return { ok: true, order: { id, kind: body.kind, ...fields, status: 'pending', createdAt } };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The pending orders, oldest first, after any stale ones have expired. */
  function pending(accountId) {
    expire();
    return db.prepare("SELECT * FROM orders WHERE account_id = ? AND status = 'pending' ORDER BY created_at, rowid").all(accountId).map(toOrder);
  }

  const list = (accountId, limit = 20) => db.prepare('SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(accountId, limit)
    .map((r) => ({ ...toOrder(r), doneAt: r.done_at, result: r.result === null ? null : JSON.parse(r.result) }));

  /** A Mac takes a pending order to run. One UPDATE decides, so of two Macs asking at once exactly one wins; the other
   *  hears 409 (the order is no longer waiting) and leaves it alone. */
  function claim(accountId, id, device) {
    expire();
    const by = typeof device === 'string' && device.length <= 100 ? device : null;
    const changed = db.prepare("UPDATE orders SET status = 'running', device = ?, claimed_at = ? WHERE id = ? AND account_id = ? AND status = 'pending'")
      .run(by, now(), String(id), accountId).changes;
    const r = db.prepare('SELECT * FROM orders WHERE id = ? AND account_id = ?').get(String(id), accountId);
    if (!r) return fail(404, 'No such order.');
    return Number(changed) ? { ok: true, order: toOrder(r) } : fail(409, 'That order is no longer waiting.');
  }

  /** The Mac reports an order landed (`ok: true`) or failed. */
  function done(accountId, id, result) {
    const r = result !== null && typeof result === 'object' ? result : {};
    const kept = { ok: r.ok === true };
    for (const key of ['error', 'caption']) if (text300(r[key]) !== undefined) kept[key] = text300(r[key]);
    const changed = db.prepare("UPDATE orders SET status = ?, done_at = ?, result = ? WHERE id = ? AND account_id = ? AND status IN ('pending', 'running')")
      .run(kept.ok ? 'done' : 'failed', now(), JSON.stringify(kept), String(id), accountId).changes;
    return Number(changed) ? { ok: true } : fail(404, 'No such order.');
  }

  return { place, pending, claim, list, done, expire };
}
