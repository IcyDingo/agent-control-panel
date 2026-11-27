// Issues: the owner's list of work, kept per workspace, that agents pick up. An issue is a one-line title with items
// under it; it may have a space (one it made, or one it was linked to), the folder its agents start in, and the launch
// choices its first pick-up made. An item is one line, to do, being worked on (by the agent a launch started), or done
// (a merged pull request from one of its agent's branches, or the owner's tick). Kept in a 0600 JSON file in Glue's own
// folder. Node standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TITLE_MAX = 120, TEXT_MAX = 300, NOTES_MAX = 4000, NOTE_MAX = 1000, FILES_MAX = 20;
/** A file's name as kept: its last part only (never a path), without control characters, 120 characters at most. */
export const fileName = (v) => String(v ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
const filesIn = (v) => (Array.isArray(v) ? v : []).filter((f) => f && ID.test(f.id ?? '') && fileName(f.name) && Number.isFinite(f.size))
  .slice(0, FILES_MAX).map((f) => ({ id: f.id, name: fileName(f.name), size: Math.max(0, Math.floor(f.size)), at: Number.isFinite(f.at) ? f.at : 0 }));
/** Notes: lines kept, each line's end and the whole trimmed, blank runs of lines made one. */
const notesOf = (v) => String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
const CHOICES = ['agentKind', 'login', 'model', 'effort', 'mode'];
const blank = () => Object.create(null);
const newId = () => randomBytes(4).toString('hex');
/** One line: newlines and runs of space become one space, trimmed. */
const line = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const ID = /^[0-9a-f]{8}$/;
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
const no = (error) => ({ ok: false, error });
const OK = { ok: true };

/** What a saved launch choice set keeps: the five a pick-up uses, strings only. */
function choicesIn(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  for (const k of CHOICES) if (typeof c[k] === 'string' && c[k].length <= 80) out[k] = c[k];
  return Object.keys(out).length ? out : null;
}
function itemIn(x) {
  if (!x || typeof x !== 'object' || !ID.test(x.id ?? '') || !str(x.text, TEXT_MAX)) return null;
  const state = ['todo', 'working', 'done'].includes(x.state) ? x.state : 'todo';
  return { id: x.id, text: x.text, state, sessionId: str(x.sessionId, 64), launchId: str(x.launchId, 64),
           branches: Array.isArray(x.branches) ? [...new Set(x.branches.filter((b) => str(b, 250)))] : [],
           doneBy: state === 'done' && ['merge', 'tick'].includes(x.doneBy) ? x.doneBy : null,
           pr: state === 'done' && Number.isInteger(x.pr) ? x.pr : null, doneAt: state === 'done' && Number.isFinite(x.doneAt) ? x.doneAt : 0, at: Number.isFinite(x.at) ? x.at : 0, startedAt: Number.isFinite(x.startedAt) ? x.startedAt : 0, note: str(x.note, NOTE_MAX) ?? '', files: filesIn(x.files) };
}
function issueIn(x) {
  if (!x || typeof x !== 'object' || !ID.test(x.id ?? '') || !str(x.title, TITLE_MAX)) return null;
  const items = (Array.isArray(x.items) ? x.items : []).map(itemIn).filter(Boolean);
  return { id: x.id, title: x.title, space: str(x.space, 64), owns: x.owns === true && Boolean(str(x.space, 64)),
           folder: typeof x.folder === 'string' && path.isAbsolute(x.folder) ? x.folder : null, choices: choicesIn(x.choices),
           notes: str(x.notes, NOTES_MAX) ?? '', files: filesIn(x.files), items: items.filter((it, i) => items.findIndex((y) => y.id === it.id) === i) };
}
const copy = (v) => JSON.parse(JSON.stringify(v));

/**
 * @param {object} o `file`: where the list is kept; `now`: the clock
 */
export function createIssues({ file, now = Date.now } = {}) {
  const st = blank(); // workspace id → issues, in order
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [ws, list] of Object.entries(saved?.ws && typeof saved.ws === 'object' ? saved.ws : {})) {
      if (!Array.isArray(list)) continue;
      const got = list.map(issueIn).filter(Boolean);
      st[ws] = got.filter((x, i) => got.findIndex((y) => y.id === x.id) === i);
    }
  } catch {}
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({ v: 1, ws: st }), { mode: 0o600 });
    fs.renameSync(tmpFile, file);
    fs.chmodSync(file, 0o600);
  }
  const issuesOf = (ws) => (st[ws] ??= []);
  const find = (ws, id) => (st[ws] ?? []).find((x) => x.id === id) ?? null;
  const findItem = (ws, issue, item) => { const i = find(ws, issue); return i ? { i, it: i.items.find((y) => y.id === item) ?? null } : { i: null, it: null }; };
  const fresh = (list) => { let id; do id = newId(); while (list.some((x) => x.id === id)); return id; };
  const titleOf = (v) => { const t = line(v); return !t ? no('A goal needs a title.') : t.length > TITLE_MAX ? no(`A title is at most ${TITLE_MAX} characters.`) : { ok: true, t }; };
  const textOf = (v) => { const t = line(v); return !t ? no('A part needs some text.') : t.length > TEXT_MAX ? no(`A part is at most ${TEXT_MAX} characters.`) : { ok: true, t }; };
  const NOISSUE = no('That goal is gone.'), NOITEM = no('That part is gone.');

  return {
    /** A workspace's issues, in order (copies). */
    list: (ws) => copy(st[ws] ?? []),
    create(ws, title) {
      const t = titleOf(title);
      if (!t.ok) return t;
      const list = issuesOf(ws), id = fresh(list);
      list.push({ id, title: t.t, space: null, owns: false, folder: null, choices: null, notes: '', files: [], items: [] });
      save();
      return { ok: true, id };
    },
    /** Several goals with their parts at once (pasted text): all checked first, then made in order with one save, so
     *  one that does not fit makes none. `[{ title, items: [text] }]`, at most 30 goals and 50 parts each. */
    createMany(ws, goals) {
      if (!Array.isArray(goals) || !goals.length) return no('There are no goals to make.');
      if (goals.length > 30) return no('At most 30 goals at once.');
      const want = [];
      for (const g of goals) {
        const t = titleOf(g?.title);
        if (!t.ok) return t;
        const items = Array.isArray(g?.items) ? g.items : [];
        if (items.length > 50) return no('A goal takes at most 50 parts at once.');
        const texts = [];
        for (const x of items) { const p = textOf(x); if (!p.ok) return p; texts.push(p.t); }
        want.push({ title: t.t, texts });
      }
      const list = issuesOf(ws), ids = [];
      for (const g of want) {
        const id = fresh(list), items = [];
        for (const text of g.texts) items.push({ id: fresh(items), text, state: 'todo', sessionId: null, launchId: null, branches: [], doneBy: null, pr: null, doneAt: 0, at: now(), note: '', files: [] });
        list.push({ id, title: g.title, space: null, owns: false, folder: null, choices: null, notes: '', files: [], items });
        ids.push(id);
      }
      save();
      return { ok: true, ids };
    },
    rename(ws, id, title) {
      const i = find(ws, id), t = titleOf(title);
      if (!i) return NOISSUE;
      if (!t.ok) return t;
      i.title = t.t; save(); return OK;
    },
    remove(ws, id) {
      const list = st[ws] ?? [], at = list.findIndex((x) => x.id === id);
      if (at < 0) return NOISSUE;
      list.splice(at, 1); save(); return OK;
    },
    addItem(ws, issue, text) {
      const i = find(ws, issue), t = textOf(text);
      if (!i) return NOISSUE;
      if (!t.ok) return t;
      const id = fresh(i.items);
      i.items.push({ id, text: t.t, state: 'todo', sessionId: null, launchId: null, branches: [], doneBy: null, pr: null, doneAt: 0, at: now(), note: '', files: [] });
      save();
      return { ok: true, id };
    },
    editItem(ws, issue, item, text) {
      const { i, it } = findItem(ws, issue, item), t = textOf(text);
      if (!i) return NOISSUE;
      if (!it) return NOITEM;
      if (!t.ok) return t;
      it.text = t.t; save(); return OK;
    },
    removeItem(ws, issue, item) {
      const i = find(ws, issue);
      if (!i) return NOISSUE;
      const at = i.items.findIndex((y) => y.id === item);
      if (at < 0) return NOITEM;
      i.items.splice(at, 1); save(); return OK;
    },
    /** Move an item before another of its issue (or to the end), or an issue before another (or to the end). */
    move(ws, { issue, item, before } = {}) {
      const list = st[ws] ?? [];
      const arr = item == null ? list : find(ws, issue)?.items;
      if (!arr) return NOISSUE;
      const id = item == null ? issue : item, from = arr.findIndex((x) => x.id === id);
      if (from < 0) return item == null ? NOISSUE : NOITEM;
      if (before != null && !arr.some((x) => x.id === before)) return no('There is nothing to put it before.');
      if (before === id) return OK;
      const [x] = arr.splice(from, 1);
      const to = before == null ? arr.length : arr.findIndex((y) => y.id === before);
      arr.splice(to, 0, x);
      save();
      return OK;
    },
    /** Done by the owner's tick, or back to to do. */
    tick(ws, issue, item, on) {
      const { i, it } = findItem(ws, issue, item);
      if (!i) return NOISSUE;
      if (!it) return NOITEM;
      if (on) Object.assign(it, { state: 'done', doneBy: 'tick', pr: null, doneAt: now() });
      else Object.assign(it, { state: 'todo', doneBy: null, pr: null, doneAt: 0, sessionId: null, launchId: null, branches: [] });
      save();
      return OK;
    },
    /** Back to to do, its agent left as it is. */
    back(ws, issue, item) {
      const { i, it } = findItem(ws, issue, item);
      if (!i) return NOISSUE;
      if (!it) return NOITEM;
      Object.assign(it, { state: 'todo', doneBy: null, pr: null, doneAt: 0, sessionId: null, launchId: null, branches: [] });
      save();
      return OK;
    },
    /** Its space, and whether the issue made it. */
    setSpace(ws, issue, space, owns) {
      const i = find(ws, issue);
      if (!i) return NOISSUE;
      i.space = str(space, 64); i.owns = Boolean(owns && i.space); save(); return OK;
    },
    /** A space went: every issue of it is unlinked. */
    unlinkSpace(ws, space) {
      let changed = false;
      for (const i of st[ws] ?? []) if (i.space === space) { i.space = null; i.owns = false; changed = true; }
      if (changed) save();
      return OK;
    },
    /** The folder its agents start in, and the launch choices a pick-up uses. */
    setLaunch(ws, issue, { folder, choices } = {}) {
      const i = find(ws, issue);
      if (!i) return NOISSUE;
      if (folder !== undefined && !(typeof folder === 'string' && path.isAbsolute(folder))) return no('A folder is an absolute path.');
      if (folder !== undefined) i.folder = folder;
      if (choices !== undefined) i.choices = choicesIn(choices);
      save();
      return OK;
    },
    /** A launch started an agent on it. */
    startItem(ws, issue, item, launchId) {
      const { i, it } = findItem(ws, issue, item);
      if (!i) return NOISSUE;
      if (!it) return NOITEM;
      Object.assign(it, { state: 'working', launchId: str(String(launchId ?? ''), 64) || null, sessionId: null, branches: [], doneBy: null, pr: null, startedAt: now() });
      save();
      return OK;
    },
    /** The session a launch turned out to be: the item it was for, once, or null. */
    claimItem(ws, launchId, sessionId) {
      for (const i of st[ws] ?? []) for (const it of i.items) {
        if (it.state === 'working' && it.launchId === launchId && !it.sessionId) { it.sessionId = String(sessionId); save(); return { ws, issue: i.id, item: it.id }; }
      }
      return null;
    },
    /** A branch its agent was seen on: kept once. */
    addBranch(ws, issue, item, branch) {
      const { it } = findItem(ws, issue, item);
      if (!it || !str(branch, 250) || it.branches.includes(branch)) return;
      it.branches.push(branch); save();
    },
    /** Done by a merged pull request. */
    done(ws, issue, item, pr) {
      const { i, it } = findItem(ws, issue, item);
      if (!i) return NOISSUE;
      if (!it) return NOITEM;
      Object.assign(it, { state: 'done', doneBy: 'merge', pr: Number.isInteger(pr) ? pr : null, doneAt: now() });
      save();
      return OK;
    },
    /** An issue's notes: the context every pick-up from it is given. Empty clears them. */
    setNotes(ws, issue, text) {
      const i = find(ws, issue), t = notesOf(text);
      if (!i) return NOISSUE;
      if (t.length > NOTES_MAX) return no(`Notes are at most ${NOTES_MAX.toLocaleString('en')} characters.`);
      i.notes = t; save(); return OK;
    },
    /** An item's own note, given with it when it is picked up. Empty clears it. */
    setItemNote(ws, issue, item, text) {
      const { i, it } = findItem(ws, issue, item), t = notesOf(text);
      if (!i) return NOISSUE;
      if (!it) return NOITEM;
      if (t.length > NOTE_MAX) return no(`A note is at most ${NOTE_MAX.toLocaleString('en')} characters.`);
      it.note = t; save(); return OK;
    },
    /** A file attached to an issue (`item` null) or to one of its items: its name and size; the bytes are the server's
     *  to keep. Returns its id. */
    addFile(ws, issue, item, { name, size } = {}) {
      const i = find(ws, issue), it = item == null ? null : i?.items.find((y) => y.id === item), n = fileName(name);
      if (!i) return NOISSUE;
      if (item != null && !it) return NOITEM;
      if (!n) return no('A file needs a name.');
      const list = (it ?? i).files;
      if (list.length >= FILES_MAX) return no(`At most ${FILES_MAX} files each.`);
      const id = fresh(list);
      list.push({ id, name: n, size: Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0, at: now() });
      save();
      return { ok: true, id, name: n };
    },
    /** Take a file off; returns it, so its bytes can go too. */
    removeFile(ws, issue, item, file) {
      const i = find(ws, issue), it = item == null ? null : i?.items.find((y) => y.id === item);
      if (!i) return NOISSUE;
      if (item != null && !it) return NOITEM;
      const list = (it ?? i).files, at = list.findIndex((f) => f.id === file);
      if (at < 0) return no('That file is gone.');
      const [f] = list.splice(at, 1);
      save();
      return { ok: true, file: f };
    },
    /** A workspace that goes takes its issues with it, so a new one by the same id never sees them. */
    dropWorkspace(ws) {
      if (!(ws in st)) return OK;
      delete st[ws]; save(); return OK;
    },
    /** Every item not done that an agent was started on, across workspaces: for linking, branches and merges. */
    openItems() {
      const out = [];
      for (const [ws, list] of Object.entries(st)) for (const i of list) for (const it of i.items) {
        if (it.state === 'working') out.push({ ws, issue: i.id, item: it.id, sessionId: it.sessionId, launchId: it.launchId, branches: [...it.branches], folder: i.folder, startedAt: it.startedAt ?? 0 });
      }
      return out;
    },
  };
}
