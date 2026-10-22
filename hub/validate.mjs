// What a handle, a text, a link and a pair of coordinates may be on the hub. Each returns the tidied value, or null when it
// is not acceptable (anything that is not a string is null everywhere), so callers have one thing to check.

/** Words that are routes or roles of the hub itself, never a person's handle. */
export const RESERVED = new Set(['me', 'api', 'device', 'login', 'logout', 'chat', 'friends', 'universe', 'home', 'admin', 'hub']);
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/; // GitHub's rule: 1–39 of a-z 0-9 and -, not starting or ending with -

/** A handle, lowercased, or null. */
export function handle(raw) {
  if (typeof raw !== 'string') return null;
  const h = raw.toLowerCase();
  return HANDLE.test(h) && !RESERVED.has(h) ? h : null;
}

/** A text in NFC with control characters stripped and whitespace collapsed to single spaces ("\n" kept from 1000 up),
 *  trimmed; null when it is empty or longer than `max`. */
export function text(raw, max) {
  if (typeof raw !== 'string') return null;
  const clean = raw.normalize('NFC').replace(/[^\P{Cc}\t\n\r]/gu, '');
  const t = max >= 1000
    ? clean.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).join('\n').trim()
    : clean.replace(/\s+/g, ' ').trim();
  return t && t.length <= max ? t : null;
}

/** As `text`, but the empty string is a valid answer. */
export const optionalText = (raw, max) => (raw === '' ? '' : text(raw, max));

/** '' (no link), an http(s) URL of up to 200 characters without whitespace, or null. */
export function link(raw) {
  if (typeof raw !== 'string') return null;
  if (raw === '') return '';
  return raw.length <= 200 && /^https?:\/\/\S+$/.test(raw) ? raw : null;
}

/** '412, -88' or '-3 7' → { x, y } (two integers, each within a million), else null. */
export function coordsText(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(-?\d+)(?:\s*,\s*|\s+)(-?\d+)$/.exec(raw.trim());
  if (!m) return null;
  const x = Number(m[1]), y = Number(m[2]);
  return Math.abs(x) <= 1e6 && Math.abs(y) <= 1e6 ? { x, y } : null;
}
