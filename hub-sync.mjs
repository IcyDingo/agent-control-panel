// Pushes the World to the hub: the public projection (what strangers may see) and the owner-only status.
//
// The panel calls `schedule()` whenever the World may have changed; this module waits a moment so a burst becomes one
// push, skips a push the hub already has (same hash) unless a half-hour heartbeat is due, and handles every way the hub
// can answer without ever throwing, because the panel must carry on working offline. The system and the status are
// judged separately (the balance moves on every scan while the projection rarely does). The only state kept is in memory,
// apart from `hub.saveSync`, which remembers the last accepted push across restarts. `stop()` is for good: afterwards
// `schedule()` and `flush()` do nothing, and a push already under way arms no retry.

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
  let stopped = false;
  let statusHash = null, statusAt = 0;   // the status the hub last took, and when
  let statusFailed = false;          // lastError is the status's

  const setError = (message, fromStatus = false) => { lastError = message; statusFailed = fromStatus; };

  function clearTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    nextAt = null;
  }

  /** Wait `ms` (but never past an earlier wait already pending, and never short of a backoff) and then push. */
  function arm(ms) {
    if (stopped) return;
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
    if (!valid) { setError('The world could not be projected; nothing was sent.'); return; }
    const hash = crypto.createHash('sha256').update(JSON.stringify(valid)).digest('hex');
    const last = hub.lastSync();
    if (hash !== refusedHash && !(hash === last?.hash && now() - last.at < HEARTBEAT)) {
      const seq = now();
      const r = await hub.request('PUT', '/api/me/system', { body: { pv: PROJECTION_VERSION, seq, device: hub.status().device, snapshot: valid } });
      if (r.status === 401) { setError('Sign in again.'); return; }
      if (r.status === 409) {   // another Mac is ahead of us; the last writer wins, so this push is as good as done
        hub.saveSync({ seq, hash, at: now() });
        lastOk = now();
        setError('Another Mac is syncing this account.');
        return;
      }
      if (r.status === 0 || r.status >= 500) { setError(sentence(r, UNREACHABLE)); backoff(); return; }
      if (!r.ok) { setError(sentence(r, 'The hub refused the world.')); refusedHash = hash; return; }
      hub.saveSync({ seq, hash, at: now() });
      lastOk = now();
      lastError = null;
      statusFailed = false;
      refusedHash = null;
      retryWait = FIRST_RETRY;
      notBefore = 0;
    }
    await pushStatus();
  }

  /** The owner-only status goes when it changed or the heartbeat is due; a failure keeps the old hash so the next flush retries. */
  async function pushStatus() {
    const body = status();
    const sh = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (sh === statusHash && now() - statusAt < HEARTBEAT) return;
    const s = await hub.request('PUT', '/api/me/status', { body });
    if (s.status === 401) { setError('Sign in again.', true); return; }
    if (!s.ok) { setError(sentence(s, UNREACHABLE), true); return; }
    statusHash = sh;
    statusAt = now();
    if (statusFailed) { lastError = null; statusFailed = false; }
  }

  /** Push now. A second call while a push is under way waits for that one. */
  function flush() {
    if (stopped) return Promise.resolve();
    clearTimer();
    inflight ??= push()
      .catch((e) => { log('hub sync failed:', e?.message ?? String(e)); setError('Sync failed.'); })
      .finally(() => { inflight = null; });
    return inflight;
  }

  /** The World may have changed: push soon (in a second if urgent, else in ten), once for any number of calls. */
  function schedule({ urgent = false } = {}) {
    arm(urgent ? URGENT : DEBOUNCE);
  }

  const state = () => ({ lastOk, lastError, nextAt, pending: timer !== null || inflight !== null });

  function stop() {
    stopped = true;
    clearTimer();
  }

  return { schedule, flush, state, stop };
}
