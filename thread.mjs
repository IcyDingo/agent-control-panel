// The open session's thread as the page shows it: the items read from its transcript, with the state hooks add to them.
//
// The transcript says what happened; hooks say how a tool call is going before the transcript catches up. Either can
// arrive first, so the merge is keyed and order-independent: a tool row is keyed by its tool_use id (by tool name and
// input JSON for a hook without one), whichever side comes first creates the row, and the other fills it in. A row is
// what its transcript item says, with the hooks' state folded over it and its tool_result's state, preview and end time
// over that; a refusal outlasts the result that reports it. Hook state is kept apart from the rows, for the last 300
// keys, so a thread read back after the hooks ran (a session opened mid-turn) is annotated all the same. Every call
// compares the rows it touched before and after and emits the difference once: new rows, and updates to old ones.

import { summaryOf } from './history.mjs';

const KEEP = 300; // keys of hook state kept per thread
const RANK = { running: 0, done: 1, failed: 2, refused: 3 }; // a call's state only moves forwards
const STATE = { PreToolUse: 'running', PostToolUse: 'done', PostToolUseFailure: 'failed', PermissionDenied: 'refused' };

/** A tool call's row key from a hook event (or a request in its shape): its id, else its tool and input. */
export function toolKey(e) {
  return typeof e.tool_use_id === 'string' ? 'tool:' + e.tool_use_id
    : 'tool~' + e.tool_name + ':' + JSON.stringify(e.tool_input ?? {});
}

/** Hook state `m` with news `p` folded in, whatever order the news came in: a state never goes back, the first end
 *  time stands, and a settled request stays settled. */
function fold(m = {}, p) {
  const out = { ...m };
  if (p.state && !(RANK[out.state] >= RANK[p.state])) out.state = p.state;
  if (p.endedAt != null) out.endedAt ??= p.endedAt;
  if ('settledWhy' in p) { if (!('settledWhy' in out)) out.settledWhy = p.settledWhy; out.waiting = false; }
  else if (p.waiting && !('settledWhy' in out)) out.waiting = true;
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A thread that merges transcript items, hook events and held requests, and tells `emit` what changed. */
export function createThread({ emit }) {
  const rows = new Map();    // key → { item, seq, res?, hook? }: res is the folded tool_result, hook state baked on trim
  const orphans = new Map(); // tool_use id → key of a result row whose call is not here (yet)
  const memory = new Map();  // key → hook state, oldest first; survives reset
  const alias = new Map();   // tool~ key → the row key of the latest call with that tool and input; survives reset
  let seq = 0, touched = null; // key → its row as it read before this call

  function view(key) {
    const r = rows.get(key);
    if (!r) return null;
    if (r.item.who !== 'tool') return r.item;
    const m = memory.get(key) ?? r.hook ?? {}, v = { ...r.item };
    v.state = m.state === 'refused' ? 'refused' : r.res?.state ?? m.state ?? v.state;
    if ('waiting' in m) v.waiting = m.waiting;
    if ('settledWhy' in m) v.settledWhy = m.settledWhy;
    if (r.res) v.preview = r.res.preview;
    const end = r.res?.endedAt ?? m.endedAt;
    if (end != null) v.endedAt = end;
    return v;
  }
  const touch = (key) => { if (!touched.has(key)) touched.set(key, view(key)); };

  /** Run one call's changes, then emit what they did to the rows, in one go. */
  function batch(fn) {
    touched = new Map();
    try { fn(); } finally {
      const events = [];
      let gone = 0; // removals go out first, so a stand-in is gone before the row that replaces it shows
      for (const [key, was] of touched) {
        const now = view(key);
        if (!was) { if (now) events.push(now); continue; }
        if (!now) { events.splice(gone++, 0, { who: 'update', key, patch: { removed: true } }); continue; }
        const patch = {};
        for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) if (!same(was[k], now[k])) patch[k] = now[k] ?? null;
        if (Object.keys(patch).length) events.push({ who: 'update', key, patch });
      }
      touched = null;
      if (events.length) emit(events);
    }
  }

  function remember(key, p) {
    touch(key);
    const m = fold(memory.get(key) ?? rows.get(key)?.hook, p);
    memory.delete(key);
    memory.set(key, m);
    for (const old of memory.keys()) {
      if (memory.size <= KEEP) break;
      const r = rows.get(old);
      if (r) r.hook = memory.get(old); // the row on show keeps it; only a later backfill loses it
      memory.delete(old);
    }
  }
  const resolve = (e) => { const k = toolKey(e); return alias.get(k) ?? k; };

  /** Put a tool item (from the transcript, or provisional from a hook) under its key, taking over what was
   *  recorded for it elsewhere: a provisional row and hook state under its tool~ key, and its orphaned result. */
  function placeTool(item) {
    const key = item.key, fk = toolKey({ tool_name: item.name, tool_input: item.input });
    touch(key);
    const r = rows.get(key);
    if (r) r.item = item;
    else rows.set(key, { item, seq: seq++ });
    if (fk !== key) {
      if (rows.has(fk)) { touch(fk); rows.delete(fk); }
      if (memory.has(fk)) { remember(key, memory.get(fk)); memory.delete(fk); }
      alias.delete(fk);
      alias.set(fk, key);
      if (alias.size > KEEP) alias.delete(alias.keys().next().value);
    }
    const rk = orphans.get(item.toolUseId);
    if (rk) { touch(rk); addResult(rows.get(rk).item); rows.delete(rk); orphans.delete(item.toolUseId); }
  }

  function addResult(item) {
    const key = 'tool:' + item.toolUseId, r = rows.get(key);
    if (r?.item.who === 'tool') {
      touch(key);
      r.res = { state: item.ok ? 'done' : 'failed', preview: item.preview, endedAt: item.at };
      return;
    }
    touch(item.key);
    const was = rows.get(item.key);
    if (was) was.item = item; else rows.set(item.key, { item, seq: seq++ });
    if (typeof item.toolUseId === 'string') orphans.set(item.toolUseId, item.key);
  }

  return {
    /** Items read from the transcript, by backfill or follow. */
    addItems(items) {
      batch(() => {
        for (const item of items) {
          if (item.who === 'tool') placeTool(item);
          else if (item.who === 'result') addResult(item);
          else {
            touch(item.key);
            const r = rows.get(item.key);
            if (r) r.item = item; else rows.set(item.key, { item, seq: seq++ });
          }
        }
      });
    },

    /** A hook event of this session; a subagent's are not this thread's. */
    hook(e) {
      if (!e || e.agent_id) return;
      batch(() => {
        if (e.hook_event_name === 'Stop') {
          const at = Date.now(), key = 'turn:' + at;
          touch(key);
          if (!rows.has(key)) rows.set(key, { item: { who: 'turn', key, at }, seq: seq++ });
          return;
        }
        const state = STATE[e.hook_event_name];
        if (!state) return;
        const key = resolve(e);
        remember(key, state === 'done' || state === 'failed' ? { state, endedAt: Date.now() } : { state });
        if (state === 'running' && !rows.has(key)) {
          const input = e.tool_input ?? {};
          placeTool({ who: 'tool', key, toolUseId: key.startsWith('tool:') ? key.slice(5) : null, name: e.tool_name,
                      summary: summaryOf(e.tool_name, input), input, state: 'running', at: Date.now(), pos: null });
        }
      });
    },

    /** A permission request the panel holds (`{ waiting: true }`) or has settled (`{ why }`), for the call `ref`. */
    request(ref, opts = {}) {
      batch(() => {
        if (opts.waiting) remember(resolve(ref), { waiting: true });
        else if ('why' in opts) remember(resolve(ref), { settledWhy: opts.why });
      });
    },

    /** The rows, oldest first: transcript rows in file order, rows not in the file yet (provisional calls, turn
     *  dividers) placed among them by time. */
    items() {
      const all = [...rows.values()];
      const filed = all.filter((r) => typeof r.item.pos === 'number').sort((a, b) => a.item.pos - b.item.pos || a.seq - b.seq);
      const loose = all.filter((r) => typeof r.item.pos !== 'number').sort((a, b) => a.item.at - b.item.at || a.seq - b.seq);
      const out = [];
      let i = 0, j = 0;
      while (i < filed.length || j < loose.length) {
        const r = j < loose.length && (i >= filed.length || loose[j].item.at < filed[i].item.at) ? loose[j++] : filed[i++];
        out.push(view(r.item.key));
      }
      return out;
    },

    /** Forget the rows, as when the transcript is read again from the start; hook state is kept. */
    reset() { rows.clear(); orphans.clear(); },
  };
}
