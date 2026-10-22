// What the hub's pages share: talking to the hub's API, the signed-in account, the live stream, times, and the few DOM
// helpers every page uses. Plain script, no build. Text that came from the API only ever goes in with textContent.
(() => {
  const AVATARS = 'https://avatars.githubusercontent.com/';

  /** Same-origin fetch with the session cookie, JSON in and out. Always resolves: { ok: false, error, status? } on any failure. */
  async function api(method, path, body) {
    try {
      const res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      const obj = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : null;
      if (res.ok && obj) return obj;
      return { ...obj, ok: false, status: res.status, error: typeof obj?.error === 'string' ? obj.error : 'The hub did not answer as expected.' };
    } catch {
      return { ok: false, error: 'The hub could not be reached.' };
    }
  }

  let mine = null;
  /** GET /api/me once per page load: the whole answer when signed in, null when not (or the hub is unreachable). */
  function me() {
    mine ??= api('GET', '/api/me').then((r) => (r.ok ? r : null));
    return mine;
  }

  /** Opens the account's live stream (the cookie authenticates it) and calls onEvent(type, data) for each order and order_done. */
  function events(onEvent) {
    const source = new EventSource('/api/me/events');
    for (const type of ['order', 'order_done']) {
      source.addEventListener(type, (e) => {
        let data = null;
        try { data = JSON.parse(e.data); } catch { return; }
        onEvent(type, data);
      });
    }
    return source;
  }

  /** "just now", "5 min ago", "3 h ago", "2 days ago". A bare YYYY-MM-DD is a day, not a moment: "today", "yesterday", "N days ago". */
  function rel(when) {
    if (typeof when === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(when)) {
      const [y, m, d] = when.split('-').map(Number);
      const now = new Date();
      const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, d)) / 86_400_000);
      return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    }
    const t = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
    const days = Math.floor(s / 86_400);
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }

  /** el('div', { class: 'x', text: 'hi', onclick }, child, 'text'): attributes are set as attributes, text as textContent. */
  function el(tag, attrs = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
    return node;
  }

  /** A person's picture: the image when it is a GitHub avatar, otherwise their initials in a circle. */
  function avatar(who, px = 40) {
    const label = who?.name || who?.handle || '?';
    const box = { class: 'avatar', style: `width:${px}px;height:${px}px;font-size:${Math.round(px * 0.38)}px` };
    if (typeof who?.avatar === 'string' && who.avatar.startsWith(AVATARS)) {
      return el('img', { ...box, src: who.avatar, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
    }
    const words = label.trim().split(/\s+/);
    const letters = words.length > 1 ? words[0][0] + words[1][0] : label.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '?';
    return el('span', { ...box, 'aria-hidden': 'true', text: letters.toUpperCase() });
  }

  /** Only an http(s) address is worth a link; null for anything else. */
  const safeUrl = (u) => { try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null; } catch { return null; } };

  window.Hub = { api, me, events, rel, el, avatar, safeUrl };
})();
