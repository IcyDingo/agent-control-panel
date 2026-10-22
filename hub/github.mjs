// Signing in with GitHub (the OAuth web flow), as two small functions. `fetch` is passed in so tests never touch the
// network. No scope is asked for: the public profile (numeric id, login, avatar) is all the hub needs, and the numeric
// id is the account's stable subject because a login can be renamed.

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN = 'https://github.com/login/oauth/access_token';
const USER = 'https://api.github.com/user';

export function authorizeUrl({ clientId, state, redirectUri }) {
  const u = new URL(AUTHORIZE);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', redirectUri);
  return u.toString();
}

/** Trade the callback `code` for who just signed in: `{ subject, login, avatar }`, or null when anything goes wrong. */
export async function exchange({ code, clientId, clientSecret, fetch }) {
  try {
    const t = await fetch(TOKEN, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!t.ok) return null;
    const accessToken = (await t.json())?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) return null;

    const u = await fetch(USER, { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'agent-panel-hub' } });
    if (!u.ok) return null;
    const me = await u.json();
    if (me?.id === undefined || me.id === null) return null;
    return { subject: String(me.id), login: me.login ?? null, avatar: me.avatar_url ?? null };
  } catch {
    return null;
  }
}
