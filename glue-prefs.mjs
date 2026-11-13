// Glue-wide preferences: what applies to every workspace and every page (the theme, which queues start folded, which
// events notify, the title count, what a new agent starts with, the overseer's model). Pure functions over plain
// objects; where they are kept is the caller's business. Node standard library only.
//
// Not here, on purpose: "Answering here" (`armed`). It resets to on at every start, so it is never remembered.
import { MODELS as OVERSEER_MODELS } from './overseer.mjs';

// Copied from server.mjs (importing it would start the server): `MODELS`, `EFFORTS` and `RESUME_MODES` there.
// Keep these in step with those. The empty model and effort mean "leave it to Claude Code".
const AGENT_MODELS = ['', 'opus', 'opus[1m]', 'sonnet', 'haiku', 'fable'];
const AGENT_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_MODES = ['default', 'acceptEdits', 'plan', 'auto'];
const THEMES = ['dark', 'light', 'system'];

const FOLDED_MAX = 50;       // queues remembered as folded
const FOLDED_KEY_MAX = 100;  // characters in one queue's key (`repo:<name>`)

/** What Glue starts from. `folded` is the page's own default today: its fold keys are `waiting` (never folded),
 *  `repo:<name>`, `loose` and `finished`, and only `finished` starts folded. */
export const GLUE_DEFAULTS = Object.freeze({
  theme: 'dark',
  folded: Object.freeze(['finished']),
  notify: Object.freeze({ requests: true, ci: true, watcher: true }),
  titleCount: true,
  agentDefaults: Object.freeze({ model: '', effort: '', mode: 'default', worktree: false }),
  overseerModel: 'sonnet',
  seeded: false,
});

const isBool = (v) => typeof v === 'boolean';
const oneOf = (list) => (v) => typeof v === 'string' && list.includes(v);
const isKey = (v) => typeof v === 'string' && v.length <= FOLDED_KEY_MAX;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => isObj(o) && Object.hasOwn(o, k);

// Each field: a value check, or (for a group) the checks of its members. Only these names are ever read from input.
const SHAPE = {
  theme: oneOf(THEMES),
  folded: null, // a list of keys, below
  notify: { requests: isBool, ci: isBool, watcher: isBool },
  titleCount: isBool,
  agentDefaults: { model: oneOf(AGENT_MODELS), effort: oneOf(AGENT_EFFORTS), mode: oneOf(AGENT_MODES), worktree: isBool },
  overseerModel: oneOf(OVERSEER_MODELS),
  seeded: isBool,
};
const NAMES = Object.keys(SHAPE);
const known = (o, k) => Object.hasOwn(o, k);

const copyDefault = (k) => {
  const d = GLUE_DEFAULTS[k];
  return Array.isArray(d) ? [...d] : isObj(d) ? { ...d } : d;
};

const dedupe = (a) => a.filter((k, i) => a.indexOf(k) === i);

/** Any bad or missing field falls back to its default; unknown fields are dropped. Never throws. */
export function sanitizeGlue(raw) {
  const out = {};
  for (const k of NAMES) {
    const check = SHAPE[k];
    if (k === 'folded') {
      out.folded = own(raw, k) && Array.isArray(raw[k]) ? dedupe(raw[k].filter(isKey)).slice(0, FOLDED_MAX) : copyDefault(k);
    } else if (typeof check === 'function') {
      out[k] = own(raw, k) && check(raw[k]) ? raw[k] : copyDefault(k);
    } else {
      out[k] = {};
      for (const m of Object.keys(check)) out[k][m] = own(raw, k) && own(raw[k], m) && check[m](raw[k][m]) ? raw[k][m] : GLUE_DEFAULTS[k][m];
    }
  }
  return out;
}

/** Apply a patch to Glue prefs. It refuses an unknown field (`armed` among them) or a bad value, naming the field. */
export function mergeGlue(current, patch) {
  if (!isObj(patch)) return { ok: false, error: 'Settings must be an object.' };
  const glue = sanitizeGlue(current);
  for (const k of Object.keys(patch)) {
    if (!known(SHAPE, k)) return { ok: false, error: `${k} is not a Glue setting.` };
    const v = patch[k];
    const check = SHAPE[k];
    if (k === 'folded') {
      if (!Array.isArray(v) || v.length > FOLDED_MAX || !v.every(isKey)) {
        return { ok: false, error: `folded must be at most ${FOLDED_MAX} names of ${FOLDED_KEY_MAX} characters or fewer.` };
      }
      glue.folded = dedupe(v);
    } else if (typeof check === 'function') {
      if (!check(v)) return { ok: false, error: `${k} has a value that is not allowed.` };
      glue[k] = v;
    } else {
      if (!isObj(v)) return { ok: false, error: `${k} must be an object.` };
      for (const m of Object.keys(v)) {
        if (!known(check, m)) return { ok: false, error: `${k}.${m} is not a Glue setting.` };
        if (!check[m](v[m])) return { ok: false, error: `${k}.${m} has a value that is not allowed.` };
        glue[k][m] = v[m];
      }
    }
  }
  return { ok: true, glue };
}
