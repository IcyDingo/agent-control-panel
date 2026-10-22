// The Universe as probes see it: where a probe sent from an account's spot goes, and the names of the galaxies probes
// found. Only listed (public) accounts that have a system are ever found or named: an unlisted galaxy is reached by its
// link and nothing else. Probes cost credit on the Mac, so nothing about them is kept here: the hub answers and forgets.

/** A probe looks this far either side of where it was aimed (radians). */
export const CONE = Math.PI / 6;
const normAng = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createUniverse(db) {
  // Snapshots are up to 512 KB each: aiming reads only spots, and naming reads only the spots asked for and their sun.
  const listed = () => db.prepare(`SELECT a.id, a.x, a.y, a.handle FROM accounts a
    WHERE a.visibility = 'public' AND EXISTS (SELECT 1 FROM systems s WHERE s.account_id = a.id)`).all();
  const at = (c) => db.prepare(`SELECT a.x, a.y, a.handle, a.name, a.avatar, json_extract(s.snapshot, '$.sun.look') AS look
    FROM accounts a JOIN systems s ON s.account_id = a.id WHERE a.visibility = 'public' AND a.x = ? AND a.y = ?`).get(c.x, c.y);

  /** Where a probe from `accountId`'s spot toward `ang` (map space, y down) goes: the nearest galaxy within CONE of it,
   *  else the nearest anywhere; never the sender, never one in `skip` ([{ x, y }]). `{ ok: false, none: true }` when
   *  there is no one left to find. */
  function target(accountId, ang, skip) {
    const me = db.prepare('SELECT x, y FROM accounts WHERE id = ?').get(accountId);
    if (!me) return { ok: false, none: true };
    const skipped = new Set(skip.map((c) => `${c.x},${c.y}`));
    const all = listed().filter((g) => g.id !== accountId && !skipped.has(`${g.x},${g.y}`))
      .map((g) => ({ g, d: Math.hypot(g.x - me.x, g.y - me.y), off: Math.abs(normAng(Math.atan2(g.y - me.y, g.x - me.x) - ang)) }));
    const nearest = (list) => list.reduce((best, c) => (!best || c.d < best.d ? c : best), null);
    const hit = nearest(all.filter((c) => c.off <= CONE)) ?? nearest(all);
    return hit ? { ok: true, target: { x: hit.g.x, y: hit.g.y, handle: hit.g.handle } } : { ok: false, none: true };
  }

  /** The galaxies at these spots that may be named, in the order asked: handle, name, avatar and the look of their sun. */
  function named(spots) {
    return spots.map(at).filter(Boolean).map((g) => ({
      x: g.x, y: g.y, handle: g.handle, name: g.name ?? null, avatar: g.avatar ?? null, look: g.look,
    }));
  }

  return { target, named };
}
