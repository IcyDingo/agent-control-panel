// Workspaces and logins. A workspace is how you work (Work, Private): a name, a colour, its repositories and spaces.
// A login is what it runs on: a Claude Code profile folder (`~/.claude`, `~/.claude-<name>`) or a Codex home
// (`~/.codex`, `~/.codex-<name>`). A workspace uses any number of logins, one of each provider being its default, and
// one login can serve several workspaces. No folder on disk makes a workspace: you do.
//
// Kept in a 0600 file so a restart changes nothing. Node standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** The colours a workspace can take. Amber is not one: it means "needs you" everywhere else in the panel. */
export const COLORS = { blue: '#7ea6e6', violet: '#a98af0', green: '#55b985', teal: '#5bb8c4', rose: '#e07a9a' };
/** What a login with a folder of its own runs: Claude Code, or OpenAI's Codex. */
export const PROVIDERS = ['claude', 'codex'];
/** OpenCode's login: one service for the computer, so one login, which each workspace uses or not. */
export const OPENCODE = 'opencode';
const OPENCODE_LOGIN = Object.freeze({ provider: 'opencode', label: 'OpenCode', dir: '' });

// What a workspace takes, in turn; the one on plain `~/.claude` is violet.
const PICK = ['blue', 'green', 'teal', 'rose', 'violet'];
const NAME_MAX = 24, LABEL_MAX = 40;
// A space's name, and how long a session gone from the board stays in its space (or remembered as placed).
const SPACE_MAX = 40, HOUR = 3_600_000, KEEP_MS = 14 * 86_400_000;
const isColor = (c) => typeof c === 'string' && Object.hasOwn(COLORS, c);
const blank = () => Object.create(null); // no prototype: an id like `__proto__` is just an unknown name

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

/** A short id made from a name, unique among `taken`: `Work Stuff` is `work-stuff`, then `work-stuff-2`. */
export function slugId(name, taken) {
  const base = String(name ?? '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 32) || 'x';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// A space may have one main agent: the session that leads it. Its slot is kept on the space: the session (null from the
// moment it is started until it shows up, when it is known by the id its launch gave), the model it was started on, the
// repository it leads (where its workers start), and when. A member a main agent started is its worker.
const MAIN_PENDING_MS = 10 * 60_000; // a main agent started this long ago that never showed up gives its slot back
const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : '');
/** A kept main-agent slot, cleaned, or null. */
// For the workers it may start: `keyHash` (the SHA-256 of the key its tools show Glue; the key itself is never kept
// here), `login` (the login it and its workers run on), `spawn` (false once you switch its starting workers off) and
// `started` (how many it has started in all).
const mainIn = (m) => (m && typeof m === 'object' && Number.isFinite(m.at) && (str(m.sessionId, 64) || str(m.launchId, 64))
  ? { sessionId: str(m.sessionId, 64) || null, launchId: str(m.launchId, 64) || null, model: str(m.model, 40),
      repo: typeof m.repo === 'string' && path.isAbsolute(m.repo) ? m.repo : null, at: m.at,
      ...(/^[0-9a-f]{64}$/.test(m.keyHash ?? '') ? { keyHash: m.keyHash } : {}), ...(str(m.login, 64) ? { login: str(m.login, 64) } : {}),
      ...(/^[\w.-]{1,120}\.json$/.test(m.file ?? '') ? { file: m.file } : {}), // the name of the file its key is in: a name only, never a path
      ...(m.spawn === false ? { spawn: false } : {}), started: Number.isInteger(m.started) && m.started > 0 ? m.started : 0 } : null);
/** A kept member's role: a worker, the model it was started on, and (`told`) the fingerprint of the last message of
 *  its that its main agent was told of. Nothing for an ordinary member. */
const roleIn = (m) => (m?.worker === true ? { worker: true, ...(str(m.model, 40) ? { model: str(m.model, 40) } : {}), ...(str(m.told, 64) ? { told: str(m.told, 64) } : {}) } : {});

// A profile folder's label: its name without the leading dot (`.claude-contract` is `claude-contract`).
const folderLabel = (dir) => path.basename(dir).replace(/^\./, '');

/**
 * @param {object} deps
 * @param {string} deps.file      where it is kept (0600); missing, empty or corrupt starts from what is found
 * @param {string} deps.home      the home folder, for the profile folders a v1 file's workspaces were
 * @param {Array<{id: string, dir: string, plain: boolean}>} deps.profiles  the Claude profile folders found on disk
 * @param {string|null} deps.codex  ~/.codex when it exists: an OpenAI login from the start
 */
export function createStore({ file, home = '', profiles = [], codex = null } = {}) {
  let st = { v: 2, workspaces: blank(), order: [], repos: blank(), focus: '', spaces: blank(), logins: blank(), placed: blank(), hidden: [] };
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no file yet, or unreadable */ }
  const fromDisk = saved && (saved.v === 1 || saved.v === 2) && saved.workspaces && typeof saved.workspaces === 'object';

  // ---- loading, entry by entry: anything malformed is dropped, the rest still loads
  if (fromDisk) {
    if (saved.v === 2) for (const [id, l] of Object.entries(saved.logins ?? {})) {
      if (id === OPENCODE && l?.provider === 'opencode') st.logins[id] = { ...OPENCODE_LOGIN };
      else if (l && PROVIDERS.includes(l.provider) && typeof l.label === 'string' && l.label && typeof l.dir === 'string' && path.isAbsolute(l.dir))
        st.logins[id] = { provider: l.provider, label: l.label, dir: l.dir };
    }
    for (const [id, w] of Object.entries(saved.workspaces)) {
      if (!w || typeof w.name !== 'string' || !w.name || !isColor(w.color)) continue;
      const logins = saved.v === 2 ? (Array.isArray(w.logins) ? w.logins : []).filter((l, i, a) => st.logins[l] && a.indexOf(l) === i) : [];
      const defaults = { claude: null, codex: null };
      for (const p of PROVIDERS) if (logins.includes(w.defaults?.[p]) && st.logins[w.defaults[p]].provider === p) defaults[p] = w.defaults[p];
      st.workspaces[id] = { name: w.name, color: w.color, logins, defaults };
    }
    st.order = (Array.isArray(saved.order) ? saved.order : []).filter((id, i, a) => st.workspaces[id] && a.indexOf(id) === i);
    for (const id of Object.keys(st.workspaces)) if (!st.order.includes(id)) st.order.push(id);
    for (const [key, ids] of Object.entries(saved.repos ?? {})) {
      const ws = Array.isArray(ids) ? ids.filter((id, i, a) => st.workspaces[id] && a.indexOf(id) === i) : [];
      if (ws.length) st.repos[key] = ws;
    }
    if (st.workspaces[saved.focus]) st.focus = saved.focus;
    for (const [ws, v] of Object.entries(saved.spaces && typeof saved.spaces === 'object' ? saved.spaces : {})) {
      if (!st.workspaces[ws] || !v || typeof v !== 'object') continue;
      const list = (Array.isArray(v.list) ? v.list : []).filter((x, i, a) => x && typeof x.id === 'string' && x.id
        && typeof x.name === 'string' && x.name && a.findIndex((y) => y?.id === x.id) === i)
        .map((x) => { const main = mainIn(x.main); return main ? { id: x.id, name: x.name, main } : { id: x.id, name: x.name }; });
      const members = blank();
      for (const [sid, m] of Object.entries(v.members && typeof v.members === 'object' ? v.members : {}))
        if (m && list.some((x) => x.id === m.space) && Number.isFinite(m.at)) members[sid] = { space: m.space, at: m.at, ...roleIn(m) };
      // A main agent is a member of its own space: a slot naming a session that is not there is dropped.
      for (const x of list) if (x.main?.sessionId && members[x.main.sessionId]?.space !== x.id) delete x.main;
      if (list.length) st.spaces[ws] = { list, members };
    }
    for (const [sid, m] of Object.entries(saved.placed && typeof saved.placed === 'object' ? saved.placed : {}))
      if (m && st.workspaces[m.ws] && Number.isFinite(m.at)) st.placed[sid] = { ws: m.ws, at: m.at, ...(typeof m.from === 'string' && m.from ? { from: m.from } : {}) };
    st.hidden = (Array.isArray(saved.hidden) ? saved.hidden : []).filter((d, i, a) => typeof d === 'string' && path.isAbsolute(d) && a.indexOf(d) === i);
  }

  // ---- what a workspace and a login are made of
  const newLogin = (provider, label, dir, id) => {
    id ??= slugId(label, new Set(Object.keys(st.logins)));
    st.logins[id] = { provider, label: String(label).slice(0, LABEL_MAX), dir };
    return id;
  };
  const newWorkspace = (id, name, color) => {
    const used = new Set(Object.values(st.workspaces).map((w) => w.color));
    st.workspaces[id] = { name, color: color ?? PICK.find((c) => !used.has(c)) ?? 'blue', logins: [], defaults: { claude: null, codex: null } };
    st.order.push(id);
    return id;
  };
  const attachTo = (ws, login) => {
    const w = st.workspaces[ws], p = st.logins[login].provider;
    if (!w.logins.includes(login)) w.logins.push(login);
    if (p !== 'opencode') w.defaults[p] ??= login; // OpenCode has no default: it picks its own model
  };
  const detachFrom = (ws, login) => {
    const w = st.workspaces[ws], p = st.logins[login].provider;
    w.logins = w.logins.filter((l) => l !== login);
    if (w.defaults[p] === login) w.defaults[p] = w.logins.find((l) => st.logins[l].provider === p) ?? null;
  };

  // ---- the first start: from what is on disk. A v1 file (a workspace per profile) becomes a workspace per profile
  // with that profile as its Claude login, under the same ids, so overseer files and repositories carry over.
  const plainDir = path.join(home, '.claude');
  // A workspace for each profile found that has none yet (others first, alphabetically, then plain `claude`'s), on
  // that profile as its login; on a first start with no profile at all, one on plain `claude`: signing in makes it.
  const perProfile = (list) => {
    for (const p of [...list].sort((a, b) => (a.plain - b.plain) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
      if (!st.workspaces[p.id]) attachTo(newWorkspace(p.id, folderLabel(p.dir), p.plain ? 'violet' : null), newLogin('claude', folderLabel(p.dir), p.dir, p.id));
  };
  if (fromDisk && saved.v === 1) {
    for (const id of st.order) {
      const p = profiles.find((x) => x.id === id);
      const dir = p?.dir ?? (id === 'default' ? plainDir : path.join(home, `.claude-${id}`));
      attachTo(id, newLogin('claude', st.workspaces[id].name, dir, id));
    }
    perProfile(profiles); // v1 made a workspace of every profile: one it hadn't listed yet still gets one
  } else if (!fromDisk) perProfile(profiles.length ? profiles : [{ id: 'default', dir: plainDir, plain: true }]);
  if (!fromDisk || saved.v === 1) {
    // ~/.codex, when there is one: on the workspace that runs plain `claude`, else the first.
    if (codex && !Object.values(st.logins).some((l) => l.dir === codex)) {
      const ws = st.order.find((id) => st.workspaces[id].logins.some((l) => st.logins[l].dir === plainDir)) ?? st.order[0];
      const id = newLogin('codex', 'OpenAI', codex, 'codex');
      if (ws) attachTo(ws, id);
    }
    if (!st.workspaces[st.focus]) st.focus = st.order[0] ?? '';
  }

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
  // OpenCode: one service for the computer, used by the workspaces you tick. The first time, by every one, as before.
  const ocNew = !st.logins[OPENCODE];
  if (ocNew) { st.logins[OPENCODE] = { ...OPENCODE_LOGIN }; for (const id of st.order) attachTo(id, OPENCODE); }
  const upgraded = !fromDisk || saved.v === 1; // made or upgraded on this start
  if (upgraded || ocNew) save();

  const view = (id) => ({ id, name: st.workspaces[id].name, color: st.workspaces[id].color });
  const loginView = (id) => ({ id, ...st.logins[id] });
  const NOWS = { ok: false, error: 'No such workspace.' }, NOSPACE = { ok: false, error: 'No such space.' }, NOLOGIN = { ok: false, error: 'No such login.' };
  const checkName = (name, self = null) => {
    if (typeof name !== 'string' || !name.trim()) return { error: 'A workspace needs a name.' };
    const n = name.trim();
    if (n.length > NAME_MAX) return { error: `A name is at most ${NAME_MAX} characters.` };
    if (Object.entries(st.workspaces).some(([k, o]) => k !== self && o.name.toLowerCase() === n.toLowerCase())) return { error: 'Another workspace has that name.' };
    return { name: n };
  };
  const checkLabel = (label, self = null) => {
    if (typeof label !== 'string' || !label.trim()) return { error: 'A login needs a name.' };
    const n = label.trim();
    if (n.length > LABEL_MAX) return { error: `A name is at most ${LABEL_MAX} characters.` };
    if (Object.entries(st.logins).some(([k, o]) => k !== self && o.label.toLowerCase() === n.toLowerCase())) return { error: 'Another login has that name.' };
    return { label: n };
  };

  // Spaces: named groups of a workspace's sessions, by what they work on. Not workspaces: one lives inside one.
  const spacesAt = (ws) => (st.spaces[ws] ??= { list: [], members: blank() });
  const spaceName = (ws, name, self = null) => {
    if (typeof name !== 'string' || !name.trim()) return { error: 'A space needs a name.' };
    const n = name.trim();
    if (n.length > SPACE_MAX) return { error: `A name is at most ${SPACE_MAX} characters.` };
    if ((st.spaces[ws]?.list ?? []).some((x) => x.id !== self && x.name.toLowerCase() === n.toLowerCase())) return { error: 'Another space has that name.' };
    return { name: n };
  };

  return {
    /** Whether the file was made or upgraded on this start (what an older Glue kept elsewhere may be read once). */
    upgraded,
    // ---- workspaces
    /** Every workspace, in order. */
    list: () => st.order.map((id, order) => ({ ...view(id), order })),
    /** One workspace, or null. */
    get: (id) => (st.workspaces[id] ? view(id) : null),
    /** A new workspace, using `logins` (ids) from the start. */
    createWorkspace({ name, color, logins = [] } = {}) {
      const n = checkName(name);
      if (n.error) return { ok: false, error: n.error };
      if (color !== undefined && !isColor(color)) return { ok: false, error: 'Unknown colour.' };
      const id = newWorkspace(slugId(n.name, new Set(Object.keys(st.workspaces))), n.name, color);
      for (const l of logins) if (st.logins[l]) attachTo(id, l);
      save();
      return { ok: true, id };
    },
    /** Forget a workspace: its logins stay, its repositories are unsorted again, its spaces go. Not the last one. */
    removeWorkspace(id) {
      if (!st.workspaces[id]) return NOWS;
      if (st.order.length < 2) return { ok: false, error: 'Glue needs one workspace at least.' };
      delete st.workspaces[id];
      delete st.spaces[id];
      st.order = st.order.filter((x) => x !== id);
      for (const [key, ws] of Object.entries(st.repos)) { const left = ws.filter((x) => x !== id); if (left.length) st.repos[key] = left; else delete st.repos[key]; }
      for (const [sid, m] of Object.entries(st.placed)) if (m.ws === id) delete st.placed[sid];
      if (st.focus === id) st.focus = st.order[0];
      save();
      return { ok: true };
    },
    /** Rename and/or recolour. Names are 1-24 characters, unique and case-insensitive. */
    update(id, { name, color } = {}) {
      const w = st.workspaces[id];
      if (!w) return NOWS;
      const n = name === undefined ? { name: w.name } : checkName(name, id);
      if (n.error) return { ok: false, error: n.error };
      if (color !== undefined && !isColor(color)) return { ok: false, error: 'Unknown colour.' };
      w.name = n.name;
      if (color !== undefined) w.color = color;
      save();
      return { ok: true };
    },
    /** Put the workspaces in this order. `ids` must be every current id, once each. */
    reorder(ids) {
      const same = Array.isArray(ids) && ids.length === st.order.length && new Set(ids).size === ids.length
        && ids.every((id) => typeof id === 'string' && Object.hasOwn(st.workspaces, id));
      if (!same) return { ok: false, error: 'The order must name every workspace once.' };
      st.order = [...ids];
      save();
      return { ok: true };
    },
    /** The workspace last focused. */
    focus: () => st.focus,
    setFocus(id) {
      if (!st.workspaces[id] || st.focus === id) return;
      st.focus = id;
      save();
    },

    // ---- logins
    /** Every login: { id, provider, label, dir }. */
    logins: () => Object.keys(st.logins).map(loginView),
    /** One login, or null. */
    login: (id) => (st.logins[id] ? loginView(id) : null),
    /** A new login, in no workspace yet. Its id comes from its label. */
    addLogin({ provider, label, dir } = {}) {
      if (!PROVIDERS.includes(provider)) return { ok: false, error: 'Unknown provider.' };
      const n = checkLabel(label);
      if (n.error) return { ok: false, error: n.error };
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false, error: 'A login needs its folder.' };
      if (Object.values(st.logins).some((l) => l.dir === dir)) return { ok: false, error: 'Glue already has that login.' };
      const id = newLogin(provider, n.label, dir);
      st.hidden = st.hidden.filter((d) => d !== dir); // added again on purpose
      save();
      return { ok: true, id };
    },
    /** Folders found on disk that Glue has no login for, and that weren't removed, become logins in no workspace.
     *  `found` is [{ provider, dir, id? }]. Returns the ids added. */
    addFound(found) {
      const added = [];
      for (const f of found) {
        if (st.hidden.includes(f.dir) || Object.values(st.logins).some((l) => l.dir === f.dir)) continue;
        const label = checkLabel(folderLabel(f.dir)).label ?? `${folderLabel(f.dir)}-${added.length + 2}`;
        added.push(newLogin(f.provider, label, f.dir, slugId(f.id ?? label, new Set(Object.keys(st.logins)))));
      }
      if (added.length) save();
      return added;
    },
    renameLogin(id, label) {
      if (!st.logins[id] || id === OPENCODE) return NOLOGIN;
      const n = checkLabel(label, id);
      if (n.error) return { ok: false, error: n.error };
      st.logins[id].label = n.label;
      save();
      return { ok: true };
    },
    /** Forget a login: it leaves every workspace, and its folder (not touched) isn't picked up again until shown. */
    removeLogin(id) {
      if (!st.logins[id] || id === OPENCODE) return NOLOGIN; // OpenCode is not removed here: untick it in each workspace
      for (const ws of Object.keys(st.workspaces)) detachFrom(ws, id);
      if (!st.hidden.includes(st.logins[id].dir)) st.hidden.push(st.logins[id].dir);
      delete st.logins[id];
      save();
      return { ok: true };
    },
    /** How many removed logins' folders are kept out. */
    hiddenCount: () => st.hidden.length,
    /** Pick removed logins' folders up again, on the next look at the disk. */
    unhide() {
      if (!st.hidden.length) return { ok: true };
      st.hidden = [];
      save();
      return { ok: true };
    },
    /** A workspace starts using a login; the first of its provider there becomes the default. */
    attach(ws, id) {
      if (!st.workspaces[ws]) return NOWS;
      if (!st.logins[id]) return NOLOGIN;
      attachTo(ws, id);
      save();
      return { ok: true };
    },
    /** A workspace stops using a login; when it was the default, the next of its provider is. */
    detach(ws, id) {
      if (!st.workspaces[ws]) return NOWS;
      if (!st.logins[id]) return NOLOGIN;
      detachFrom(ws, id);
      save();
      return { ok: true };
    },
    setDefault(ws, id) {
      const w = st.workspaces[ws];
      if (!w) return NOWS;
      if (!st.logins[id] || !w.logins.includes(id)) return { ok: false, error: 'That workspace doesn’t use that login.' };
      w.defaults[st.logins[id].provider] = id;
      save();
      return { ok: true };
    },
    /** The logins a workspace uses, in the order they were added. */
    loginsOf: (ws) => [...(st.workspaces[ws]?.logins ?? [])],
    /** A workspace's default login for a provider, or null. */
    defaultOf: (ws, provider) => st.workspaces[ws]?.defaults[provider] ?? null,
    /** The workspaces that use a login, in switch order. */
    usersOf: (id) => st.order.filter((ws) => st.workspaces[ws].logins.includes(id)),
    /** Where a login's sessions go when nothing else places them: the first workspace using it, in switch order. */
    homeOf: (id) => st.order.find((ws) => st.workspaces[ws].logins.includes(id)) ?? null,

    // ---- repositories
    /** The workspace ids a repository is in; [] when it is unsorted. */
    reposOf: (key) => [...(st.repos[key] ?? [])],
    /** Put a repository in these workspaces; [] forgets it. */
    assign(key, ids) {
      if (!Array.isArray(ids) || ids.some((id) => !st.workspaces[id])) return NOWS;
      const ws = [...new Set(ids)];
      if (ws.length) st.repos[key] = ws; else delete st.repos[key];
      save();
      return { ok: true };
    },
    /** Every repository that has been sorted. */
    assigned: () => Object.entries(st.repos).map(([key, ws]) => ({ key, ws: [...ws] })),

    // ---- sessions Glue started: they stay in the workspace they were started in
    setPlaced(sessionId, ws, now = Date.now()) {
      if (!st.workspaces[ws] || typeof sessionId !== 'string' || !sessionId) return;
      const from = st.placed[sessionId]?.from;
      st.placed[sessionId] = { ws, at: now, ...(from ? { from } : {}) };
      save();
    },
    placedWs: (sessionId) => (st.workspaces[st.placed[sessionId]?.ws] ? st.placed[sessionId].ws : null),
    // ---- a session handed over: the one it carries on, kept on its placed entry
    setFrom(sessionId, ws, from, now = Date.now()) {
      if (!st.workspaces[ws] || typeof sessionId !== 'string' || !sessionId || typeof from !== 'string' || !from) return;
      st.placed[sessionId] = { ...st.placed[sessionId], ws, at: st.placed[sessionId]?.at ?? now, from };
      save();
    },
    fromOf: (sessionId) => st.placed[sessionId]?.from ?? null,
    /** The session that carries on `sessionId`'s work, if one does: { id, at }. */
    handedTo(sessionId) {
      for (const [sid, m] of Object.entries(st.placed)) if (m.from === sessionId) return { id: sid, at: m.at };
      return null;
    },
    /** Stamp the placed sessions still around (at most hourly) and drop those not seen for 14 days. */
    touchPlaced(liveIds = [], now = Date.now()) {
      const live = new Set(liveIds);
      let changed = false;
      for (const [sid, m] of Object.entries(st.placed)) {
        if (live.has(sid)) { if (now - m.at > HOUR) { m.at = now; changed = true; } }
        else if (now - m.at > KEEP_MS) { delete st.placed[sid]; changed = true; }
      }
      if (changed) save();
    },

    // ---- spaces
    /** A workspace's spaces, in the order they were made; one with a main agent says which session and its model. */
    spacesOf: (ws) => (st.spaces[ws]?.list ?? []).map((x) => (x.main ? { id: x.id, name: x.name, main: { sessionId: x.main.sessionId, model: x.main.model } } : { id: x.id, name: x.name })),
    /** A space's main-agent slot ({ sessionId, launchId, model, repo, at }), or null. */
    mainOf: (ws, id) => { const m = st.spaces[ws]?.list.find((y) => y.id === id)?.main; return m ? { ...m } : null; },
    /**
     * Give a space its main agent: `{ sessionId }` for a session already in the space, or `{ launchId }` for one just
     * started, which takes the slot until it shows up (claimMain). One per space: whoever held the slot loses it.
     */
    setMain(ws, id, { sessionId = null, launchId = null, model = '', repo = null, keyHash = null, login = null, file = null } = {}, now = Date.now()) {
      if (!st.workspaces[ws]) return NOWS;
      const x = st.spaces[ws]?.list.find((y) => y.id === id);
      if (!x) return NOSPACE;
      const main = mainIn({ sessionId, launchId, model, repo, keyHash, login, file, at: now });
      if (!main) return { ok: false, error: 'No such session.' };
      if (main.sessionId && st.spaces[ws].members[main.sessionId]?.space !== id) return { ok: false, error: 'A main agent is a session of its own space.' };
      x.main = main;
      save();
      return { ok: true };
    },
    /** The session a just-started main agent turned out to be: it joins its space and takes the slot kept for it. */
    claimMain(ws, id, sessionId, now = Date.now()) {
      const x = st.spaces[ws]?.list.find((y) => y.id === id);
      if (!x?.main || x.main.sessionId || typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'No main agent is awaited there.' };
      st.spaces[ws].members[sessionId] = { space: id, at: now };
      x.main = { ...x.main, sessionId };
      save();
      return { ok: true };
    },
    clearMain(ws, id) {
      const x = st.spaces[ws]?.list.find((y) => y.id === id);
      if (x?.main) { delete x.main; save(); }
      return { ok: true };
    },
    /** The slots still waiting for their session: [{ space, launchId, at }]. One that waited over ten minutes is dropped. */
    awaitedMains(ws, now = Date.now()) {
      const out = [];
      let changed = false;
      for (const x of st.spaces[ws]?.list ?? []) {
        if (!x.main || x.main.sessionId) continue;
        if (now - x.main.at > MAIN_PENDING_MS) { delete x.main; changed = true; } else out.push({ space: x.id, launchId: x.main.launchId, at: x.main.at });
      }
      if (changed) save();
      return out;
    },
    /** What a session is in its space: its `main` agent, a `worker` one started, or nothing (null). */
    roleOf(ws, sessionId) {
      const m = st.spaces[ws]?.members[sessionId];
      if (!m) return null;
      if (st.spaces[ws].list.find((y) => y.id === m.space)?.main?.sessionId === sessionId) return 'main';
      return m.worker ? 'worker' : null;
    },
    /** The model a worker was started on, or ''. */
    workerModel: (ws, sessionId) => st.spaces[ws]?.members[sessionId]?.model ?? '',
    /** The space whose main agent holds the key with this hash: { ws, space }, or null. A key is one space's. */
    mainByKey(keyHash) {
      if (!/^[0-9a-f]{64}$/.test(keyHash ?? '')) return null;
      for (const [ws, v] of Object.entries(st.spaces)) for (const x of v.list) if (x.main?.keyHash === keyHash) return { ws, space: x.id };
      return null;
    },
    /** A main agent started one more worker: counted for good, so workers that ended do not give room back. */
    noteStarted(ws, id) {
      const x = st.spaces[ws]?.list.find((y) => y.id === id);
      if (!x?.main) return 0;
      x.main.started = (x.main.started ?? 0) + 1;
      save();
      return x.main.started;
    },
    /** Whether this main agent may start workers: yours to switch off for one, whatever Glue's own setting says. */
    setMainSpawn(ws, id, on) {
      const x = st.spaces[ws]?.list.find((y) => y.id === id);
      if (!x?.main) return { ok: false, error: 'That space has no main agent.' };
      if (on) delete x.main.spawn; else x.main.spawn = false;
      save();
      return { ok: true, spawn: Boolean(on) };
    },
    /** The fingerprint of the last message of a worker's that its main agent was told of ('' when none). */
    toldOf: (ws, sessionId) => st.spaces[ws]?.members[sessionId]?.told ?? '',
    setTold(ws, sessionId, key) {
      const m = st.spaces[ws]?.members[sessionId];
      if (!m?.worker || typeof key !== 'string' || !key || m.told === key) return;
      m.told = key.slice(0, 64);
      save();
    },
    /** The workers of a space: the ids of its members a main agent started. */
    workersOf: (ws, id) => Object.entries(st.spaces[ws]?.members ?? {}).filter(([, m]) => m.space === id && m.worker).map(([sid]) => sid),
    createSpace(ws, name) {
      if (!st.workspaces[ws]) return NOWS;
      const n = spaceName(ws, name);
      if (n.error) return { ok: false, error: n.error };
      const at = spacesAt(ws);
      let id;
      do id = randomUUID().slice(0, 8); while (at.list.some((x) => x.id === id));
      at.list.push({ id, name: n.name });
      save();
      return { ok: true, id };
    },
    renameSpace(ws, id, name) {
      if (!st.workspaces[ws]) return NOWS;
      const x = st.spaces[ws]?.list.find((y) => y.id === id);
      if (!x) return NOSPACE;
      const n = spaceName(ws, name, id);
      if (n.error) return { ok: false, error: n.error };
      x.name = n.name;
      save();
      return { ok: true };
    },
    /** Delete a space; its sessions are in no space after. */
    deleteSpace(ws, id) {
      if (!st.workspaces[ws]) return NOWS;
      const at = st.spaces[ws], i = at?.list.findIndex((y) => y.id === id) ?? -1;
      if (i < 0) return NOSPACE;
      at.list.splice(i, 1);
      for (const [sid, m] of Object.entries(at.members)) if (m.space === id) delete at.members[sid];
      save();
      return { ok: true };
    },
    /** The space a session is in, or null. */
    spaceOf: (ws, sessionId) => st.spaces[ws]?.members[sessionId]?.space ?? null,
    /** Put a session in a space; null takes it out. A main agent that leaves its space is its main agent no more, and
     *  a worker that leaves is no one's worker. `role` ({ worker: true, model }) is for a session a main agent started. */
    setSpace(ws, sessionId, id, now = Date.now(), role = null) {
      if (!st.workspaces[ws]) return NOWS;
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'No such session.' };
      const was = st.spaces[ws]?.members[sessionId];
      const leave = () => { const x = was && st.spaces[ws].list.find((y) => y.id === was.space); if (x?.main?.sessionId === sessionId) delete x.main; };
      if (id === null) {
        if (was) { leave(); delete st.spaces[ws].members[sessionId]; save(); }
        return { ok: true };
      }
      if (!st.spaces[ws]?.list.some((y) => y.id === id)) return NOSPACE;
      if (was?.space === id) { was.at = now; if (role) Object.assign(was, roleIn(role)); save(); return { ok: true }; } // already there: what it is stays
      leave();
      st.spaces[ws].members[sessionId] = { space: id, at: now, ...roleIn(role) };
      save();
      return { ok: true };
    },
    /** Stamp the members still around (at most hourly) and drop those not seen for 14 days. */
    touchSpaces(ws, liveIds = [], now = Date.now()) {
      const at = st.spaces[ws];
      if (!at) return;
      const live = new Set(liveIds);
      let changed = false;
      for (const [sid, m] of Object.entries(at.members)) {
        if (live.has(sid)) { if (now - m.at > HOUR) { m.at = now; changed = true; } }
        else if (now - m.at > KEEP_MS) {
          const x = at.list.find((y) => y.id === m.space);
          if (x?.main?.sessionId === sid) delete x.main; // its main agent is long gone: the space can have another
          delete at.members[sid];
          changed = true;
        }
      }
      if (changed) save();
    },
  };
}
