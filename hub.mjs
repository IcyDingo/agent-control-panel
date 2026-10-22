// The Mac's client for the hub: the credentials file, authenticated requests, the device sign-in and the event stream.
//
// Everything the Mac knows about the hub lives in one private file (hub.json: the token, who you are, this Mac's device id,
// the last sync, a sign-in in progress). It is re-read whenever its modification time changes, so `node server.mjs login`
// in a terminal is picked up by the running service within a call. Nothing here throws: a hub that is down, slow or
// answering nonsense becomes an `ok: false` result, because the panel must carry on working offline.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Where the hub is, until the owner hosts one: a placeholder on this machine. `ACP_HUB` overrides it. */
export const DEFAULT_HUB = 'http://127.0.0.1:4848';

const UNREACHABLE = 'Hub unreachable.';
const FIRST_WAIT = 2000, LAST_WAIT = 60_000;

/**
 * Split an event-stream buffer into its complete events, and hand back the partial block still waiting for more.
 * `data` is JSON-parsed when it parses; comments (the hub's `: ping`) and blocks without data are skipped.
 */
export function parseSse(buffer) {
  const blocks = String(buffer).replaceAll('\r\n', '\n').split('\n\n');
  const rest = blocks.pop();
  const events = [];
  for (const block of blocks) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value || 'message';
      else if (field === 'data') data.push(value);
    }
    if (!data.length) continue;
    const text = data.join('\n');
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* plain text stays text */ }
    events.push({ event, data: parsed });
  }
  return { events, rest };
}

/** Wait `ms`, or less if `signal` aborts. */
const abortableSleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

export function createHub({
  file, hubUrl = process.env.ACP_HUB ?? DEFAULT_HUB, fetch = globalThis.fetch, now = Date.now,
  sleep = abortableSleep, log = (m) => console.error(m),
} = {}) {
  const url = String(hubUrl).replace(/\/+$/, '');
  let device = randomUUID();   // this Mac's id at the hub; kept in memory across a sign-out so it survives the next login
  let st = {};                 // the file as last read
  let seen;                    // its mtimeMs then (null: no file); undefined: never looked
  let signedOut = false;       // the hub said 401 to the token we hold; cleared when the file changes

  const mtime = () => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };

  /** Reload the file if it changed since we last looked. */
  function load() {
    const m = mtime();
    if (m === seen) return;
    seen = m;
    signedOut = false;
    st = {};
    if (m === null) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) st = parsed;
    } catch {
      log(`hub: ${file} could not be read; treating it as signed out.`);
    }
    if (typeof st.device === 'string' && st.device) device = st.device;
  }

  /**
   * Write the file privately: a tmp of its own (so two writers never share one), rename, and chmod in case the file
   * existed with looser rights. A failure is logged (never with the token) and returned as false, and the file is read
   * again next time so memory never claims what the disk does not hold.
   */
  function save() {
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      // a token belongs to the hub that issued it: a file for another hub keeps that hub's url
      st = { ...st, v: 1, url: foreign() ? st.url : url, device };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
      seen = mtime();
      return true;
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
      seen = undefined;
      log(`hub: could not write ${file} (${e?.code ?? 'error'}).`);
      return false;
    }
  }

  /** The file holds a login for some other hub than the one we are pointed at. */
  const foreign = () => typeof st.url === 'string' && st.url !== '' && st.url !== url;
  const loggedIn = () => typeof st.token === 'string' && st.token !== '' && !signedOut && !foreign();
  const live = (pending) => (pending && pending.expiresAt > now() ? pending : null);

  function status() {
    load();
    const p = live(st.pending);
    return {
      url,
      loggedIn: loggedIn(),
      account: loggedIn() ? st.account ?? null : null,
      pending: p ? { userCode: p.userCode, verificationUri: p.verificationUri, expiresAt: p.expiresAt, interval: p.interval ?? 5 } : null,
      device,
    };
  }

  async function request(method, p, { body, timeout = 8000 } = {}) {
    load();
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const bearer = loggedIn();
    if (bearer) headers.authorization = `Bearer ${st.token}`;
    try {
      const res = await fetch(url + p, {
        method, headers, signal: AbortSignal.timeout(timeout),
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let parsed = {};
      if (text) { try { parsed = JSON.parse(text); } catch { /* not JSON (a proxy's page): no body */ } }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
      if (res.status === 401 && bearer) signedOut = true;
      return { ok: res.ok, status: res.status, body: parsed };
    } catch {
      return { ok: false, status: 0, body: { error: UNREACHABLE } };
    }
  }

  async function startDeviceLogin() {
    const r = await request('POST', '/api/device/code');
    const b = r.body;
    if (!r.ok || !b.device_code || !b.user_code) return { ok: false, error: b.error || (r.status ? 'The hub sent an unexpected answer.' : UNREACHABLE) };
    load();
    const pending = {
      userCode: b.user_code, verificationUri: b.verification_uri_complete ?? b.verification_uri,
      expiresAt: now() + (b.expires_in ?? 900) * 1000, interval: b.interval ?? 5, deviceCode: b.device_code,
    };
    st.pending = pending;
    if (!save()) return { ok: false, error: 'Could not write the hub file.' };
    return { ok: true, userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: pending.expiresAt, interval: pending.interval };
  }

  /** True when nothing is pending afterwards. */
  function clearPending() {
    load();
    if (!st.pending) return true;
    st.pending = null;
    return save();
  }

  async function pollDeviceLogin() {
    load();
    const pending = st.pending;
    if (!pending?.deviceCode) return 'error';
    const r = await request('POST', '/api/device/token', { body: { device_code: pending.deviceCode } });
    if (r.status === 200 && r.body.token) {
      load();
      if (foreign()) delete st.lastSync;   // that sync was with another hub
      st.url = url;
      st.token = r.body.token;
      st.account = r.body.account ?? null;
      st.pending = null;
      signedOut = false;
      return save() ? 'ok' : 'error';
    }
    if (r.status === 428) return 'pending';
    if (r.status === 429) {   // the hub wants a longer gap between polls, and counts a poll made too soon against us
      load();
      if (st.pending?.deviceCode === pending.deviceCode) {
        st.pending = { ...st.pending, interval: (st.pending.interval ?? 5) + 5 };
        save();
      }
      return 'pending';
    }
    if (r.status === 410) { clearPending(); return 'expired'; }
    if (r.status === 403) { clearPending(); return 'denied'; }
    if (pending.expiresAt <= now()) clearPending();
    return 'error';
  }

  const cancelDeviceLogin = clearPending;

  async function logout() {
    load();
    if (loggedIn()) await request('DELETE', '/api/me/tokens/self');
    try {
      fs.rmSync(file, { force: true });
    } catch (e) {
      seen = undefined;
      log(`hub: could not remove ${file} (${e?.code ?? 'error'}).`);
      return { ok: false, error: 'Could not remove the hub file.' };
    }
    st = {};
    seen = null;
    signedOut = false;
    return { ok: true };
  }

  function saveSync({ seq, hash, at }) {
    load();
    st.lastSync = { seq, hash, at };
    return save();
  }

  function lastSync() {
    load();
    return st.lastSync ?? null;
  }

  /**
   * Hold the hub's event stream open and call `onEvent(event, data)` for each event. When it drops, wait 2 s, 4 s, ... up
   * to a minute and connect again; a 401 means the token is dead, so stop. `onOpen()` is called (not waited for) each time a connection
   * is made, before its events are read. Resolves when `signal` aborts. Never throws.
   */
  async function stream(p, onEvent, { signal, onOpen } = {}) {
    let wait = FIRST_WAIT;
    while (!signal?.aborted) {
      let reader;
      const stop = () => reader?.cancel().catch(() => {});
      try {
        load();
        if (loggedIn()) {
          const res = await fetch(url + p, { headers: { authorization: `Bearer ${st.token}`, accept: 'text/event-stream' }, signal });
          if (res.status === 401) { signedOut = true; res.body?.cancel().catch(() => {}); return; }
          if (res.ok && res.body) {
            reader = res.body.getReader();
            signal?.addEventListener('abort', stop, { once: true });
            try { onOpen?.(); } catch { /* a hook's trouble is not the stream's */ }   // events missed while it was down are the caller's to fetch
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              wait = FIRST_WAIT;
              const parsed = parseSse(buffer + decoder.decode(value, { stream: true }));
              buffer = parsed.rest;
              for (const { event, data } of parsed.events) {
                try { await onEvent(event, data); } catch { /* a handler's trouble is not the stream's */ }
              }
            }
          } else res.body?.cancel().catch(() => {});
        }
      } catch { /* dropped or failed: fall through to the wait */ }
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) break;
      await sleep(wait, signal);
      wait = Math.min(wait * 2, LAST_WAIT);
    }
  }

  return { status, request, startDeviceLogin, pollDeviceLogin, cancelDeviceLogin, logout, saveSync, lastSync, stream };
}
