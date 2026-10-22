// The hub's settings, read once from the environment at start-up. Everything has a default that runs on a laptop
// (port 4848, ./data, a plain-http 127.0.0.1 URL); a real deployment sets HUB_PUBLIC_URL to its https address.

export function loadConfig(env = process.env) {
  const port = Number(env.HUB_PORT) || 4848;
  const publicUrl = (env.HUB_PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const url = new URL(publicUrl);
  const devLogin = env.HUB_DEV_LOGIN === '1';
  // The dev login signs anyone in as anyone: it must never be reachable from a real, https-served hub.
  if (devLogin && url.protocol === 'https:') throw new Error('HUB_DEV_LOGIN is refused on an https public URL');
  // GitHub sign-in needs both halves; one without the other is the same as none.
  const github = env.HUB_GITHUB_CLIENT_ID && env.HUB_GITHUB_CLIENT_SECRET
    ? { clientId: env.HUB_GITHUB_CLIENT_ID, clientSecret: env.HUB_GITHUB_CLIENT_SECRET }
    : null;
  return {
    port,
    // Where to listen. Behind Caddy on the same machine, 127.0.0.1 keeps the plain-http port off the internet; in a
    // container it must stay 0.0.0.0 (Docker's port mapping does the binding).
    bindHost: env.HUB_HOST || '0.0.0.0',
    dataDir: env.HUB_DATA || './data',
    publicUrl,
    origin: url.origin, // what a browser sends as Origin, for the same-origin check on writes
    host: url.host, // what a browser sends as Host
    github,
    devLogin,
    // Behind Caddy every connection comes from 127.0.0.1; `1` says to take the visitor's address from the last entry of
    // X-Forwarded-For instead (the one the proxy appended). Off, the header is ignored, or anyone could pick their bucket.
    trustProxy: env.HUB_TRUST_PROXY === '1',
  };
}
