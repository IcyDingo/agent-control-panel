// The hub's HTTP surface: routing, who is calling (a browser session cookie or a client token), the Host and same-origin
// checks, body caps, static files and the live-stream hookup. Everything a route actually does lives in the modules
// beside this one; this file only decides who may ask and shapes the answer. `node hub/server.mjs` runs it.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { createAccounts } from './accounts.mjs';
import { createAuth } from './auth.mjs';
import { createSystems } from './systems.mjs';
import { createOrders } from './orders.mjs';
import { createLive } from './live.mjs';
import { authorizeUrl, exchange } from './github.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 16 * 1024;
const MAX_SYSTEM_BODY = 512 * 1024;
const COOKIE = 'hub_s';
const OAUTH_COOKIE = 'hub_oauth'; // binds the GitHub state to the browser that started the sign-in
const SESSION_S = 30 * 24 * 3600;
const DEFAULT_LABEL = 'Agent Panel on a Mac';

// Only these names are ever read from disk; nothing is joined from the URL.
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const STATIC = {
  '/world.js': path.join(HERE, '..', 'public', 'world.js'),
  '/hub.js': path.join(HERE, 'public', 'hub.js'),
  '/hub.css': path.join(HERE, 'public', 'hub.css'),
  '/robots.txt': path.join(HERE, 'public', 'robots.txt'),
};
const PAGES = { '/': 'index.html', '/me': 'me.html', '/device': 'device.html' };
const SYSTEM_PAGE = 'system.html';

const HEADERS = { 'x-content-type-options': 'nosniff' };
const send = (res, code, body, { cache = 'no-store', type = 'application/json', headers } = {}) => {
  res.writeHead(code, { ...HEADERS, 'content-type': type, 'cache-control': cache, ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const fail = (res, status, error, more = {}, opts) => send(res, status, { ok: false, error, ...more }, opts);

/** The JSON body, or a rejection carrying the status to answer with. Past the cap it stops keeping data but keeps draining. */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > max) { over = true; chunks.length = 0; reject({ status: 413, error: 'That is too large.' }); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { return reject({ status: 400, error: 'The body is not JSON.' }); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return reject({ status: 400, error: 'The body is not JSON.' });
      resolve(body);
    });
    req.on('error', reject);
  });
}

const cookieValue = (req, name) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};

export function createHub(config, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const db = openDb(config.dataDir);
  const accounts = createAccounts(db, { now });
  const auth = createAuth(db, { now });
  const systems = createSystems(db, { now });
  const orders = createOrders(db, { now });
  const live = createLive();

  const publicHostname = new URL(config.publicUrl).hostname;
  const secure = config.publicUrl.startsWith('https:') ? '; Secure' : '';
  let boundPort = null;

  const sessionCookie = (id, maxAge = SESSION_S) => `${COOKIE}=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  const oauthCookie = (state, maxAge) => `${OAUTH_COOKIE}=${state}; HttpOnly; Path=/auth/github; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  const startSession = (req, accountId) => sessionCookie(auth.createSession(accountId, req.headers['user-agent']));

  /** Who is calling: the Bearer token if one is sent (and it wins, valid or not), else the session cookie. */
  function requester(req) {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer) {
      const owner = auth.tokenOwner(bearer);
      return owner ? { accountId: owner.accountId, via: 'tok', token: bearer, tokenId: owner.id } : null;
    }
    const sid = cookieValue(req, COOKIE);
    const accountId = sid && auth.sessionAccountId(sid);
    return accountId ? { accountId, via: 'web', sid } : null;
  }
  /** What a live stream remembers of a session: its hash, never the cookie itself. */
  const sessionKey = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex');

  // ---- routes: [method, path (string or RegExp with named groups), who may call, handler, options] ----
  // `who`: 'pub' nobody in particular, 'any' a signed-in cookie or token, 'web' a browser session, 'tok' a client token.
  // A web route needs the same Origin as the hub, and so does anything with `origin: true` (they change state by a browser).
  const routes = [];
  const route = (method, pattern, who, handler, opts = {}) => routes.push({ method, pattern, who, handler, ...opts });

  const staticFile = (file, cache) => async ({ res }) => {
    let data;
    try { data = await fs.promises.readFile(file); } catch { return fail(res, 404, 'Not found.'); }
    // A page is never shown inside another site's frame (its buttons place orders and approve Macs).
    const headers = path.extname(file) === '.html' ? { 'x-frame-options': 'DENY' } : undefined;
    send(res, 200, data, { type: TYPES[path.extname(file)] ?? 'application/octet-stream', cache, headers });
  };

  route('GET', '/healthz', 'pub', ({ res }) => send(res, 200, { ok: true, v: 1 }));
  for (const [url, file] of Object.entries(STATIC)) route('GET', url, 'pub', staticFile(file, 'public, max-age=300'));
  for (const [url, name] of Object.entries(PAGES)) route('GET', url, 'pub', staticFile(path.join(HERE, 'public', name), 'public, max-age=30'));
  route('GET', /^\/@[^/]+$/, 'pub', staticFile(path.join(HERE, 'public', SYSTEM_PAGE), 'public, max-age=30'));

  // Public reads of a system.
  const PUBLIC = { cache: 'public, max-age=30' };
  const showSystem = (res, account) => account
    ? send(res, 200, { ok: true, ...systems.publicView(account, systems.get(account.id)) }, PUBLIC)
    : fail(res, 404, 'No system by that name.');
  route('GET', '/api/systems/at', 'pub', ({ res, q }) => {
    const [x, y] = [q.get('x'), q.get('y')];
    return /^-?\d{1,9}$/.test(x ?? '') && /^-?\d{1,9}$/.test(y ?? '') ? showSystem(res, accounts.byCoords(Number(x), Number(y))) : fail(res, 404, 'No system by that name.');
  });
  route('GET', /^\/api\/systems\/@(?<handle>[^/]+)$/, 'pub', ({ res, params }) => showSystem(res, accounts.byHandle(params.handle)));

  // Signing in and out.
  route('GET', '/login/github', 'pub', ({ res, q }) => {
    if (!config.github) return fail(res, 404, 'GitHub sign-in is not configured on this hub.');
    const state = auth.newState(q.get('return_to'));
    const location = authorizeUrl({ clientId: config.github.clientId, state, redirectUri: `${config.publicUrl}/auth/github/callback` });
    send(res, 302, '', { headers: { location, 'set-cookie': oauthCookie(state, 600) } });
  });
  route('GET', '/auth/github/callback', 'pub', async ({ req, res, q }) => {
    if (!config.github) return fail(res, 404, 'GitHub sign-in is not configured on this hub.');
    // The state must come back in the cookie of the browser that began the sign-in, or a link an attacker authorised
    // would sign a victim into the attacker's account. Either way the cookie is spent.
    const clear = oauthCookie('', 0);
    const state = q.get('state');
    const mine = state && cookieValue(req, OAUTH_COOKIE) === state;
    const taken = mine ? auth.takeState(state) : null;
    if (!taken) return fail(res, 400, 'That sign-in link has expired; try again.', {}, { headers: { 'set-cookie': clear } });
    const who = await exchange({ code: q.get('code'), clientId: config.github.clientId, clientSecret: config.github.clientSecret, fetch });
    if (!who) return fail(res, 502, 'GitHub did not confirm the sign-in.', {}, { headers: { 'set-cookie': clear } });
    const { account } = accounts.signIn({ provider: 'github', subject: who.subject, login: who.login, avatar: who.avatar });
    send(res, 302, '', { headers: { location: taken.returnTo ?? '/me', 'set-cookie': [startSession(req, account.id), clear] } });
  });
  route('POST', '/auth/dev', 'pub', ({ req, res, body }) => {
    if (!config.devLogin) return fail(res, 404, 'Dev sign-in is off on this hub.');
    if (typeof body.login !== 'string' || !body.login.trim() || body.login.length > 100) return fail(res, 422, 'Say who to sign in as.');
    const { account } = accounts.signIn({ provider: 'dev', subject: body.login.trim(), login: body.login.trim() });
    send(res, 200, { ok: true, account }, { headers: { 'set-cookie': startSession(req, account.id) } });
  }, { origin: true });
  route('POST', '/logout', 'pub', ({ req, res }) => {
    const sid = cookieValue(req, COOKIE);
    if (sid) { auth.deleteSession(sid); live.closeBySession(sessionKey(sid)); }
    send(res, 200, { ok: true }, { headers: { 'set-cookie': sessionCookie('', 0) } });
  }, { origin: true });

  // The device flow: the Mac asks for a code and polls; the owner approves it in the browser.
  route('POST', '/api/device/code', 'pub', ({ res }) => {
    const d = auth.startDevice();
    send(res, 200, {
      ok: true, ...d, verification_uri: `${config.publicUrl}/device`,
      verification_uri_complete: `${config.publicUrl}/device?code=${d.user_code}`,
    });
  });
  const DEVICE_ERRORS = { pending: [428, 'authorization_pending'], slow_down: [429, 'slow_down'], expired: [410, 'expired'], denied: [403, 'denied'] };
  route('POST', '/api/device/token', 'pub', ({ res, body }) => {
    const r = auth.pollDevice(body.device_code);
    if (r.status === 'ok') {
      const { id, handle, x, y, name, avatar } = accounts.byId(r.accountId);
      return send(res, 200, { ok: true, token: r.token, account: { id, handle, x, y, name, avatar } });
    }
    const [status, error] = DEVICE_ERRORS[r.status] ?? [404, 'No such device code.'];
    fail(res, status, error);
  });
  route('POST', '/api/device/approve', 'web', ({ res, who, body }) => {
    const label = typeof body.label === 'string' && body.label.trim() && body.label.trim().length <= 60 ? body.label.trim() : DEFAULT_LABEL;
    const r = auth.approveDevice(body.user_code, who.accountId, label);
    r.ok ? send(res, 200, { ok: true }) : fail(res, 404, r.error);
  });
  route('POST', '/api/device/deny', 'web', ({ res, who, body }) => {
    const r = auth.denyDevice(body.user_code, who.accountId);
    r.ok ? send(res, 200, { ok: true }) : fail(res, 404, r.error);
  });

  // The signed-in account.
  route('GET', '/api/me', 'any', ({ res, who }) => {
    const account = accounts.byId(who.accountId);
    if (!account) return fail(res, 401, 'Sign in first.');
    send(res, 200, {
      ok: true, account, identities: accounts.identitiesOf(account.id),
      ...(who.via === 'web' ? { tokens: auth.listTokens(account.id) } : {}),
      status: systems.getStatus(account.id), orders: orders.list(account.id, 5),
    });
  });
  route('PATCH', '/api/me/profile', 'web', ({ res, who, body }) => {
    const r = accounts.updateProfile(who.accountId, body);
    r.ok ? send(res, 200, { ok: true, account: r.account }) : fail(res, r.status, r.error);
  });
  // A revoked token's open stream ends with it, so a Mac that has lost its sign-in stops hearing orders.
  route('DELETE', '/api/me/tokens/self', 'tok', ({ res, who }) => {
    const ok = auth.revokeByToken(who.token);
    live.closeByToken(who.tokenId);
    send(res, 200, { ok });
  });
  route('DELETE', /^\/api\/me\/tokens\/(?<id>[^/]+)$/, 'web', ({ res, who, params }) => {
    if (!auth.revokeToken(who.accountId, params.id)) return fail(res, 404, 'No such token.');
    live.closeByToken(params.id);
    send(res, 200, { ok: true });
  });

  // What the Mac pushes, and the owner's status.
  const outcome = (res, r) => {
    const { status, ...rest } = r;
    r.ok ? send(res, 200, rest) : send(res, status, rest);
  };
  route('PUT', '/api/me/system', 'tok', ({ res, who, body }) => outcome(res, systems.put(who.accountId, body)), { max: MAX_SYSTEM_BODY });
  route('PUT', '/api/me/status', 'tok', ({ res, who, body }) => outcome(res, systems.putStatus(who.accountId, body)));
  route('GET', '/api/me/status', 'any', ({ res, who }) => send(res, 200, { ok: true, status: systems.getStatus(who.accountId) }));

  // Orders: placed in the browser, executed by the Mac, announced to it over the stream.
  route('GET', '/api/me/orders', 'any', ({ res, who, q }) => {
    if (q.get('status') === 'pending') return send(res, 200, { ok: true, orders: orders.pending(who.accountId) });
    const n = Math.floor(Number(q.get('limit')));
    send(res, 200, { ok: true, orders: orders.list(who.accountId, Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 20) });
  });
  route('POST', '/api/me/orders', 'web', ({ res, who, body }) => {
    const r = orders.place(who.accountId, body);
    if (r.ok) live.emit(who.accountId, 'order', r.order);
    outcome(res, r);
  });
  route('POST', /^\/api\/me\/orders\/(?<id>[^/]+)\/claim$/, 'tok', ({ res, who, params, body }) =>
    outcome(res, orders.claim(who.accountId, params.id, body.device)));
  route('POST', /^\/api\/me\/orders\/(?<id>[^/]+)\/done$/, 'tok', ({ res, who, params, body }) => {
    const { id } = params;
    const r = orders.done(who.accountId, id, body);
    if (r.ok) {
      const result = { ok: body.ok === true };
      for (const k of ['error', 'caption']) if (typeof body[k] === 'string') result[k] = body[k].slice(0, 300);
      live.emit(who.accountId, 'order_done', { id, ...result });
    }
    outcome(res, r);
  });
  route('GET', '/api/me/events', 'any', ({ res, who }) => {
    live.subscribe(who.accountId, res, who.via === 'tok' ? { tokenId: who.tokenId } : { sessionId: sessionKey(who.sid) });
  });

  // ---- the request ----

  const hostOk = (host) => host === config.host || (boundPort !== null && host === `${publicHostname}:${boundPort}`);

  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      if (typeof r.pattern === 'string') { if (r.pattern === pathname) return { r, params: {} }; continue; }
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      try { return { r, params: Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])) }; } catch { return null; } // a bad escape names nothing
    }
    return null;
  }

  async function handle(req, res) {
    if (!hostOk(req.headers.host)) return fail(res, 421, 'Wrong host.');
    let url;
    try { url = new URL(req.url, 'http://hub.invalid'); } catch { return fail(res, 400, 'Bad address.'); }
    const hit = match(req.method, url.pathname);
    if (!hit) return fail(res, 404, 'Not found.');
    const { r, params } = hit;

    if ((r.origin ?? r.who === 'web') && req.headers.origin !== config.origin) return fail(res, 403, 'That request came from the wrong place.');
    let who = null;
    if (r.who !== 'pub') {
      who = requester(req);
      if (!who) return fail(res, 401, 'Sign in first.');
      if (r.who === 'web' && who.via !== 'web') return fail(res, 403, 'That needs a browser sign-in.');
      if (r.who === 'tok' && who.via !== 'tok') return fail(res, 403, 'That needs the Mac app signed in.');
    }
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try { body = await readBody(req, r.max ?? MAX_BODY); } catch (e) {
        if (e?.status === undefined) throw e;
        return fail(res, e.status, e.error, {}, e.status === 413 ? { headers: { connection: 'close' } } : undefined);
      }
    }
    await r.handler({ req, res, q: url.searchParams, params, who, body });
  }

  // Nothing a request carries may throw out of the handler: an unhandled rejection would stop the server.
  const server = http.createServer((req, res) => handle(req, res).catch((err) => {
    console.error('request failed:', err?.message ?? err);
    if (!res.headersSent) send(res, 500, { error: 'server error' }); else res.destroy();
  }));

  const listen = (port = config.port, bindHost = '0.0.0.0') => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => {
      server.off('error', reject);
      boundPort = server.address().port;
      resolve({ port: boundPort });
    });
  });

  const close = () => new Promise((resolve) => {
    const finish = () => { try { db.close(); } catch { /* already closed */ } resolve(); };
    if (!server.listening) return finish();
    server.close(finish);
    server.closeAllConnections(); // an open event stream would otherwise hold the close forever
  });

  return { server, listen, close, db, accounts, auth, systems, orders, live };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = loadConfig();
  const hub = createHub(config);
  await hub.listen();
  console.log(`hub → ${config.publicUrl}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => hub.close().then(() => process.exit(0)));
}
