// Pushes the World to the hub: the public projection (what strangers may see) and the owner-only status.
//
// The panel calls `schedule()` whenever the World may have changed; this module waits a moment so a burst becomes one
// push, skips a push the hub already has (same hash) unless a half-hour heartbeat is due, and handles every way the hub
// can answer without ever throwing, because the panel must carry on working offline. The only state kept is in memory,
// apart from `hub.saveSync`, which remembers the last accepted push across restarts.

import crypto from 'node:crypto';
import { publicProjection, validProjection, PROJECTION_VERSION } from './world.mjs';

const DEBOUNCE = 10_000, URGENT = 1_000, HEARTBEAT = 30 * 60_000;
const FIRST_RETRY = 30_000, LAST_RETRY = 600_000;

const UNREACHABLE = 'Hub unreachable.';

/** The hub's own sentence for a failed answer, or ours. */
const sentence = (r, fallback) => (typeof r.body?.error === 'string' && r.body.error ? r.body.error : fallback);

export function createHubSync({ hub, projection, status, now = Date.now, timers = { setTimeout, clearTimeout }, log = console.error }) {
  let timer = null, nextAt = null;   // the pending wait and when it ends
  let inflight = null;               // the push being made, if any
  let lastOk = null, lastError = null;
  let refusedHash = null;            // the hub refused this projection; do not send it again until it changes
  let retryWait = FIRST_RETRY;       // the next backoff step
  let notBefore = 0;                 // while the hub is down, no wait ends before this

  function clearTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    nextAt = null;
  }

  /** Wait `ms` (but never past an earlier wait already pending, and never short of a backoff) and then push. */
  function arm(ms) {
    const deadline = now() + Math.max(ms, notBefore - now());
    if (timer !== null && nextAt <= deadline) return;
    clearTimer();
    nextAt = deadline;
    timer = timers.setTimeout(async () => {
      timer = null;
      nextAt = null;
      if (inflight) await inflight;   // a change made mid-push still gets its own push
      flush();
    }, deadline - now());
  }

  function backoff() {
    notBefore = now() + retryWait;
    clearTimer();
    arm(retryWait);
    retryWait = Math.min(retryWait * 2, LAST_RETRY);
  }

  async function push() {
    if (!hub.status().loggedIn) return;
    const summary = projection();
    if (!summary) return;
    const valid = validProjection(publicProjection(summary));
    if (!valid) { lastError = 'The world could not be projected; nothing was sent.'; return; }
    const hash = crypto.createHash('sha256').update(JSON.stringify(valid)).digest('hex');
    if (hash === refusedHash) return;
    const last = hub.lastSync();
    if (hash === last?.hash && now() - last.at < HEARTBEAT) return;

    const seq = now();
    const r = await hub.request('PUT', '/api/me/system', { body: { pv: PROJECTION_VERSION, seq, device: hub.status().device, snapshot: valid } });
    if (r.status === 401) { lastError = 'Sign in again.'; return; }
    if (r.status === 409) {   // another Mac is ahead of us; the last writer wins, so this push is as good as done
      hub.saveSync({ seq, hash, at: now() });
      lastOk = now();
      lastError = 'Another Mac is syncing this account.';
      return;
    }
    if (r.status === 0 || r.status >= 500) { lastError = sentence(r, UNREACHABLE); backoff(); return; }
    if (!r.ok) { lastError = sentence(r, 'The hub refused the world.'); refusedHash = hash; return; }

    hub.saveSync({ seq, hash, at: now() });
    lastOk = now();
    lastError = null;
    refusedHash = null;
    retryWait = FIRST_RETRY;
    notBefore = 0;
    const s = await hub.request('PUT', '/api/me/status', { body: status() });
    if (s.status === 401) lastError = 'Sign in again.';
    else if (!s.ok) lastError = sentence(s, UNREACHABLE);
  }

  /** Push now. A second call while a push is under way waits for that one. */
  function flush() {
    clearTimer();
    inflight ??= push()
      .catch((e) => { log('hub sync failed:', e?.message ?? String(e)); lastError = 'Sync failed.'; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  /** The World may have changed: push soon (in a second if urgent, else in ten), once for any number of calls. */
  function schedule({ urgent = false } = {}) {
    arm(urgent ? URGENT : DEBOUNCE);
  }

  const state = () => ({ lastOk, lastError, nextAt, pending: timer !== null || inflight !== null });

  return { schedule, flush, state, stop: clearTimer };
}
