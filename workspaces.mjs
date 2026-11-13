// Workspaces: the few named, coloured groups (Work, Private) the panel is sorted into. Each is one Claude Code profile
// (`~/.claude` is id `default`, `~/.claude-<name>` is `<name>`), so a workspace and its login go together.
//
// This keeps what the profiles can't say for themselves: each workspace's name and colour, their order, which
// workspace(s) each repository belongs to, and the one last focused (for notifications and new pages made server-side).
// Kept in a 0600 file so a restart changes nothing. Node standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** The colours a workspace can take. Amber is not one: it means "needs you" everywhere else in the panel. */
export const COLORS = { blue: '#7ea6e6', violet: '#a98af0', green: '#55b985', teal: '#5bb8c4', rose: '#e07a9a' };

// What a non-plain workspace takes, in turn; the plain profile is always violet.
const PICK = ['blue', 'green', 'teal', 'rose'];
const NAME_MAX = 24;
const isColor = (c) => typeof c === 'string' && Object.hasOwn(COLORS, c);

/** What a repository is called in the store: its GitHub slug, else its git common dir, else its folder. */
export function repoKey({ slug, common, dir } = {}) {
  if (slug) return `gh:${slug}`;
  if (common) return `git:${common}`;
  return `dir:${dir}`;
}

/** A desktop notification about a workspace that isn't in focus: its name and a count, never a repository, pull
 *  request, branch or session. `waits` for something waiting on your click (`n` of them there, at least the one being
 *  told of), else a failed check. */
export const countOnly = (name, { waits = false, n = 1 } = {}) => ({ title: 'Glue',
  text: `${name}: ${waits ? `${Number.isInteger(n) && n > 1 ? n : 1} needs you` : 'a check failed'}` });

// A profile's folder label: the folder name without its leading dot (`.claude-contract` is `claude-contract`).
const labelOf = (p) => (p.dir ? path.basename(p.dir) : p.plain ? 'claude' : `claude-${p.id}`).replace(/^\./, '');

/**
 * @param {object} deps
 * @param {string} deps.file       where it is kept (0600); missing, empty or corrupt starts from the profiles
 * @param {Array<{id: string, dir?: string, plain: boolean}>} deps.profiles  as from listProfiles()
 */
export function createStore({ file, profiles = [] } = {}) {
  // No prototype, so an id or key like `constructor` or `__proto__` is just an unknown name, never a stray lookup.
  let st = { v: 1, workspaces: Object.create(null), order: [], repos: Object.create(null), focus: '' };
  const plainOf = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.v === 1 && saved.workspaces && typeof saved.workspaces === 'object') {
      for (const [id, w] of Object.entries(saved.workspaces))
        if (w && typeof w.name === 'string' && w.name && isColor(w.color)) st.workspaces[id] = { name: w.name, color: w.color };
      st.order = (Array.isArray(saved.order) ? saved.order : []).filter((id, i, a) => st.workspaces[id] && a.indexOf(id) === i);
      for (const id of Object.keys(st.workspaces)) if (!st.order.includes(id)) st.order.push(id);
      for (const [key, ids] of Object.entries(saved.repos ?? {})) {
        const ws = Array.isArray(ids) ? ids.filter((id, i, a) => st.workspaces[id] && a.indexOf(id) === i) : [];
        if (ws.length) st.repos[key] = ws;
      }
      if (st.workspaces[saved.focus]) st.focus = saved.focus;
    }
  } catch { /* no file yet, or unreadable: start from the profiles */ }

  function save() {
    if (!file) return;
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
      console.error(`workspaces: could not write ${file} (${e?.code ?? 'error'}).`);
    }
  }

  function sync(list = []) {
    let changed = false;
    for (const p of list) plainOf.set(p.id, !!p.plain);
    for (const p of list) {
      if (st.workspaces[p.id]) continue;
      const used = new Set(Object.values(st.workspaces).map((w) => w.color));
      st.workspaces[p.id] = { name: labelOf(p), color: p.plain ? 'violet' : PICK.find((c) => !used.has(c)) ?? 'blue' };
      // Others sit before the plain profile, which stays last, as they do when first made.
      const at = st.order.findIndex((id) => plainOf.get(id));
      if (p.plain || at < 0) st.order.push(p.id); else st.order.splice(at, 0, p.id);
      changed = true;
    }
    if (!st.workspaces[st.focus]) { st.focus = st.order[0] ?? ''; changed = true; }
    if (changed) save();
  }

  // The first run orders others alphabetically, then the plain one; later arrivals join as `sync` places them.
  sync([...profiles].sort((a, b) => (a.plain - b.plain) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

  const view = (id) => ({ id, name: st.workspaces[id].name, color: st.workspaces[id].color });

  return {
    /** Every workspace, in order. */
    list: () => st.order.map((id, order) => ({ ...view(id), order })),
    /** One workspace, or null. */
    get: (id) => (st.workspaces[id] ? view(id) : null),
    /** Rename and/or recolour. Names are 1-24 characters, unique and case-insensitive. */
    update(id, { name, color } = {}) {
      const w = st.workspaces[id];
      if (!w) return { ok: false, error: 'No such workspace.' };
      let next = w.name;
      if (name !== undefined) {
        if (typeof name !== 'string') return { ok: false, error: 'A workspace needs a name.' };
        next = name.trim();
        if (!next) return { ok: false, error: 'A workspace needs a name.' };
        if (next.length > NAME_MAX) return { ok: false, error: `A name is at most ${NAME_MAX} characters.` };
        const taken = Object.entries(st.workspaces).some(([k, o]) => k !== id && o.name.toLowerCase() === next.toLowerCase());
        if (taken) return { ok: false, error: 'Another workspace has that name.' };
      }
      if (color !== undefined && !isColor(color)) return { ok: false, error: 'Unknown colour.' };
      w.name = next;
      if (color !== undefined) w.color = color;
      save();
      return { ok: true };
    },
    /** The workspace ids a repository is in; [] when it is unsorted. */
    reposOf: (key) => [...(st.repos[key] ?? [])],
    /** Put a repository in these workspaces; [] forgets it. */
    assign(key, ids) {
      if (!Array.isArray(ids) || ids.some((id) => !st.workspaces[id])) return { ok: false, error: 'No such workspace.' };
      const ws = [...new Set(ids)];
      if (ws.length) st.repos[key] = ws; else delete st.repos[key];
      save();
      return { ok: true };
    },
    /** Every repository that has been sorted. */
    assigned: () => Object.entries(st.repos).map(([key, ws]) => ({ key, ws: [...ws] })),
    /** The workspace last focused. */
    focus: () => st.focus,
    setFocus(id) {
      if (!st.workspaces[id] || st.focus === id) return;
      st.focus = id;
      save();
    },
    /** Add a workspace for a profile seen for the first time; the others are kept as they are. */
    sync,
  };
}
