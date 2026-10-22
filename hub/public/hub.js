// What the hub's pages share: talking to the hub's API, the signed-in account, the live stream, times, and the few DOM
// helpers every page uses. Plain script, no build. Text that came from the API only ever goes in with textContent.
(() => {
  const AVATARS = 'https://avatars.githubusercontent.com/';

  /** Same-origin fetch with the session cookie, JSON in and out. Always resolves: { ok: false, error, status? } on any failure.
   *  `{ cache }` passes through to fetch ('no-store' when an answer the browser kept would be stale). */
  async function api(method, path, body, { cache } = {}) {
    try {
      const res = await fetch(path, {
        method, credentials: 'same-origin', ...(cache && { cache }),
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

  /** Opens the account's live stream (the cookie authenticates it) and calls onEvent(type, data) for each order and order_done.
   *  The stream does not replay what it missed, so { onOpen } runs on every connect and reconnect, for the page to look again. */
  function events(onEvent, { onOpen } = {}) {
    const source = new EventSource('/api/me/events');
    if (onOpen) source.addEventListener('open', () => onOpen());
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

  /** A number from a string, always the same for the same string (FNV-1a), for picking a shade that never flickers. */
  function hashOf(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  /** One of `list`, chosen by the string: the same string always picks the same one. */
  const pick = (s, list) => list[hashOf(s) % list.length];

  /** The brand's mosaic: a grid of flat square cells with no gaps, `cols` across. Each entry is the cell's class
   *  (hub.css: q0–q3 the quiet graphites, a0–a2 the ambers). */
  function mosaic(cells, cols) {
    const grid = el('div', { class: 'mosaic', 'aria-hidden': 'true', style: `--cols:${cols}` });
    for (const c of cells) grid.append(el('span', { class: c }));
    return grid;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  /** The last 100 days as a mosaic, oldest first, today at the bottom right: amber for a day the agents worked, graphite
   *  for a quiet one, with a caption. `worked` is the projection's list of days; anything else means no days. */
  function daysMosaic(worked) {
    const had = new Set(Array.isArray(worked) ? worked : []), now = new Date(), cells = [];
    let count = 0;
    for (let back = 99; back >= 0; back--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const lit = had.has(k);
      if (lit) count++;
      cells.push(pick(k, lit ? ['a0', 'a0', 'a1', 'a2'] : ['q1', 'q1', 'q2', 'q2', 'q3', 'q4']));
    }
    return el('div', { class: 'days' },
      mosaic(cells, 20),
      el('div', { class: 'cap' }, el('span', { text: 'Last 100 days' }), el('span', { text: `${plural(count, 'day', 'days')} with work` })));
  }

  /** The mascot: a small stone creature in the spirit of Rocky from Project Hail Mary. A rock of a body, no face, five
   *  jointed legs ending in three-fingered hands, one leg raised in greeting with an amber chime above it. Static
   *  markup of our own, so innerHTML is safe here. `px` is the width; the height follows (40 by 48 units). */
  const MASCOT = `<svg viewBox="0 0 40 48" xmlns="http://www.w3.org/2000/svg">
    <g stroke="#5a5248" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="M11 29 L6 38 L5 46"/><path d="M15 31 L12 39 L11 46"/><path d="M20 32 L20 40 L20 46"/><path d="M25 31 L28 39 L29 46"/><path d="M29 28 L35 20 L37 11"/>
    </g>
    <g stroke="#5a5248" stroke-width="1.5" stroke-linecap="round" fill="none">
      <path d="M5 46 l-2.4 1.4 M5 46 l0 2.5 M5 46 l2.4 1.4"/><path d="M11 46 l-2.4 1.4 M11 46 l0 2.5 M11 46 l2.4 1.4"/>
      <path d="M20 46 l-2.4 1.4 M20 46 l0 2.5 M20 46 l2.4 1.4"/><path d="M29 46 l-2.4 1.4 M29 46 l0 2.5 M29 46 l2.4 1.4"/>
      <path d="M37 11 l-2 -2.3 M37 11 l0.5 -3 M37 11 l2.6 -1.5"/>
    </g>
    <ellipse cx="20" cy="25" rx="11.5" ry="9" fill="#8f8678"/>
    <path d="M9.5 23.5 Q20 11.5 30.5 23.5 Q20 21 9.5 23.5Z" fill="#aaa092"/>
    <ellipse cx="15" cy="27" rx="2.2" ry="1.4" fill="#6f675b"/><ellipse cx="24.5" cy="29" rx="1.8" ry="1.2" fill="#6f675b"/><ellipse cx="21" cy="23" rx="1.4" ry="1" fill="#6f675b"/>
    <circle cx="37.5" cy="4.5" r="1.5" fill="var(--amber)"/>
  </svg>`;
  function mascot(px = 40) {
    const box = el('span', { class: 'mascot', 'aria-hidden': 'true', style: `width:${px}px` });
    box.innerHTML = MASCOT;
    return box;
  }

  window.Hub = { api, me, events, rel, el, avatar, safeUrl, hashOf, pick, mosaic, daysMosaic, plural, mascot };
})();
