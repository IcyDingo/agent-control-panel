// The hub's rate limits: a token bucket per (name, subject), where the subject is a visitor's address or an account.
// Each name has a capacity and a window; the bucket refills continuously, so a burst of the full count is allowed and
// then the rate settles to count/window. Everything is in memory: a restart forgets, which is fine for a limit. The
// table is pruned when it grows, dropping every bucket that is full again (one nobody would notice losing).

/** [calls, per milliseconds]. */
export const RATES = {
  signin: [10, 60_000], // GitHub sign-in starts and returns, dev sign-in; per address
  device_code: [5, 60_000], // a Mac asking for a code; per address
  device_poll: [30, 60_000], // a Mac polling for its token (a code paces itself with slow_down too); per address
  approve: [10, 60_000], // approving or denying a code; per account
  profile: [10, 60_000], // per account
  system: [12, 60_000], // a Mac pushing its galaxy; per account
  status: [30, 60_000], // a Mac pushing its status; per account
  order: [10, 60_000], // placing an order; per account
  order_step: [30, 60_000], // claiming or finishing one; per account
  probe: [30, 60_000], // a Mac asking where a probe goes; per account
  named: [60, 60_000], // the names of found galaxies; per address
};
export const PRUNE_AT = 5000;

export function createLimits({ now = Date.now, rates = RATES } = {}) {
  const table = new Map(); // "name\nsubject" → { tokens, at }
  const nameOf = (key) => key.slice(0, key.indexOf('\n'));
  // A clock that steps back (an NTP correction) must not drain a bucket: time only ever adds tokens.
  const fill = (b, [n, perMs], t) => { b.tokens = Math.min(n, b.tokens + (Math.max(0, t - b.at) * n) / perMs); b.at = Math.max(b.at, t); };

  // Pruning walks the whole table, so it must not happen on every insert when a flood keeps the table full of buckets
  // still owed tokens: after a prune the next one waits until the table has doubled.
  let pruneAt = PRUNE_AT;
  function prune(t) {
    for (const [key, b] of table) {
      fill(b, rates[nameOf(key)], t);
      if (b.tokens >= rates[nameOf(key)][0]) table.delete(key);
    }
    pruneAt = Math.max(PRUNE_AT, 2 * table.size);
  }

  /** Spends one call of `name` for `subject`: { ok: true }, or { ok: false, retryAfter } in whole seconds (at least 1). */
  function take(name, subject) {
    const rate = rates[name];
    if (!rate) throw new Error(`unknown limit: ${name}`);
    const [n, perMs] = rate, t = now(), key = `${name}\n${subject}`;
    let b = table.get(key);
    if (!b) {
      if (table.size >= pruneAt) prune(t);
      b = { tokens: n, at: t };
      table.set(key, b);
    } else fill(b, rate, t);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfter: Math.max(1, Math.ceil(((1 - b.tokens) * perMs) / n / 1000)) };
  }

  return { take, size: () => table.size };
}

/** The subject a visitor's address makes: an IPv4 address as it is (a mapped `::ffff:1.2.3.4` becomes `1.2.3.4`), an
 *  IPv6 address cut to its /64, because one visitor holds a whole /64 (or more) and could otherwise take a fresh bucket
 *  for every request. Anything unparseable is used as it came. */
export function subjectOf(address) {
  let a = String(address ?? '').trim().toLowerCase();
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  if (!a.includes(':')) return a;
  const [head, tail] = a.split('::');
  if (tail === undefined && head.split(':').length !== 8) return a;
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Whether `address` is one a proxy of ours would connect from: loopback, or a private range (Docker's bridge, a LAN).
 *  A forwarded-for header from anywhere else is a visitor's claim, not a proxy's word. */
export function privatePeer(address) {
  let a = String(address ?? '').trim().toLowerCase();
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  if (a === '::1' || a.startsWith('127.')) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // fc00::/7, the private IPv6 block
  return false;
}
