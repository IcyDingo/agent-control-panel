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
};
export const PRUNE_AT = 5000;

export function createLimits({ now = Date.now, rates = RATES } = {}) {
  const table = new Map(); // "name\nsubject" → { tokens, at }
  const nameOf = (key) => key.slice(0, key.indexOf('\n'));
  const fill = (b, [n, perMs], t) => { b.tokens = Math.min(n, b.tokens + ((t - b.at) * n) / perMs); b.at = t; };

  function prune(t) {
    for (const [key, b] of table) {
      fill(b, rates[nameOf(key)], t);
      if (b.tokens >= rates[nameOf(key)][0]) table.delete(key);
    }
  }

  /** Spends one call of `name` for `subject`: { ok: true }, or { ok: false, retryAfter } in whole seconds (at least 1). */
  function take(name, subject) {
    const rate = rates[name];
    if (!rate) throw new Error(`unknown limit: ${name}`);
    const [n, perMs] = rate, t = now(), key = `${name}\n${subject}`;
    let b = table.get(key);
    if (!b) {
      if (table.size >= PRUNE_AT) prune(t);
      b = { tokens: n, at: t };
      table.set(key, b);
    } else fill(b, rate, t);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfter: Math.max(1, Math.ceil(((1 - b.tokens) * perMs) / n / 1000)) };
  }

  return { take, size: () => table.size };
}
