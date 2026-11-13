// GitHub for the board: the pull requests of the branches agents are on, what runs on the default branch after a merge,
// and a notification when either fails. It asks through the gh CLI the user is already signed in to, so the panel
// holds no token. Which repository a folder belongs to is read from its git config file, never by running git.
// Everything here is off the request path: tick() polls on its own clock, and state() and forSession() only hand out
// what the last poll found.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MIN = 60_000;
const FRESH_MS = 15 * MIN;   // a failure first seen after a start still notifies if it is this recent
const MAX_REPOS = 6;         // per workspace, its most recently active repositories are watched; the rest are counted
const MAX_MINE = 8;          // and, with `mine`, up to this many more where only your own pull requests are open
const SEEN_MAX = 300;        // failures already told about, kept across restarts
const OPEN_LIMIT = 50;
/** What a run on the default branch can be started by. A fork's pull request from a branch of the same name is not one. */
const MAIN_EVENTS = new Set(['push', 'merge_group', 'schedule', 'workflow_dispatch', 'workflow_run', 'release', 'deployment', 'repository_dispatch']);
/** The ones a merge causes: only these notify. */
const NOTIFY_EVENTS = new Set(['push', 'merge_group']);
const HINTS = {
  missing: 'Install the GitHub CLI (gh) to see pull requests and CI here.',
  'signed-out': 'Run gh auth login in a terminal to see pull requests and CI here.',
};
const TITLE = 'Glue · CI failed';

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
/** An ISO time as milliseconds; null for none, and for the year-one date GitHub gives a check that has not finished. */
const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) && t > 0 ? t : null; };

// ---------------------------------------------------------------- which repository a folder is

/** A value from a git config line: quotes removed, or an unquoted trailing comment cut off. */
function configValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    let out = '';
    for (let i = 1; i < v.length; i++) {
      if (v[i] === '\\' && i + 1 < v.length) { out += v[++i]; continue; }
      if (v[i] === '"') break;
      out += v[i];
    }
    return out;
  }
  return v.replace(/\s+[#;].*$/, '').trim();
}

/** The first url under [remote "origin"] in a git config file's text, or null. pushurl, includes and insteadOf are ignored. */
export function originOf(configText) {
  let inside = false;
  for (const raw of String(configText ?? '').split('\n')) {
    let line = raw.trim();
    if (line.startsWith('[')) {
      const m = line.match(/^\[\s*([\w.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/);
      inside = Boolean(m) && m[1].toLowerCase() === 'remote' && m[2] === 'origin';
      line = m?.[3] ?? ''; // a key may follow its section header on the same line
    }
    if (!inside) continue;
    const kv = line.match(/^url\s*=\s*(.*)$/i);
    if (kv) return configValue(kv[1]) || null;
  }
  return null;
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[\w.-]{1,100}$/;
const HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);
/**
 * The github.com repository a remote URL names, as { owner, name, slug }. Null for anything else: another host, an
 * SSH host alias, a path that is not owner/name. The URL itself is never kept: it can carry a token.
 */
export function parseRemote(url) {
  const u = String(url ?? '').trim();
  const m = u.match(/^(?:https?|git|ssh|git\+ssh):\/\/(?:[^@/]*@)?([^/:@]+)(?::\d+)?\/([^/]+)\/([^/]+?)\/?$/i)
    ?? u.match(/^(?:[^@/:]+@)?([^/:@]+):(?!\/)([^/]+)\/([^/]+?)\/?$/); // git@github.com:owner/name
  if (!m || !HOSTS.has(m[1].toLowerCase())) return null;
  const owner = m[2], name = m[3].replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null;
  return { owner, name, slug: `${owner}/${name}` };
}

/**
 * The owner/name of the repository whose shared git dir is `common` (a worktree and its main checkout share one), from
 * its config file. `read(file, max)` returns the file's text and may throw.
 */
export function slugOf(common, read) {
  if (typeof common !== 'string' || !common) return null;
  try { return parseRemote(originOf(read(path.join(common, 'config'), 262144)))?.slug ?? null; } catch { return null; }
}

// ---------------------------------------------------------------- reading what gh says

const RUN_URL = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/;
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);
/**
 * A pull request's checks as one state. The same check re-run is counted once, by its latest run. Skipped, neutral and
 * cancelled checks count for nothing.
 * @returns {{ checks: 'passing'|'failing'|'running'|'none', counts: {pass, fail, pending},
 *             failing: [{name, url, runId, jobId}], finishedAt: number|null, runningSince: number|null }}
 * `runningSince` is when the oldest check still running started: how long it has been going.
 */
export function rollup(contexts) {
  const latest = new Map();
  for (const c of Array.isArray(contexts) ? contexts : []) {
    if (!c || typeof c !== 'object') continue;
    const status = c.__typename === 'StatusContext' || (c.context && !c.name);
    const name = String((status ? c.context : c.name) ?? '');
    const key = status ? `status\0${name}` : `${c.workflowName ?? ''}\0${name}`;
    const at = ms(c.startedAt) ?? ms(c.completedAt) ?? 0;
    const was = latest.get(key);
    if (was && was.at > at) continue;
    const up = (v) => String(v ?? '').toUpperCase();
    let kind = 'other';
    if (status) kind = ['FAILURE', 'ERROR'].includes(up(c.state)) ? 'fail' : ['PENDING', 'EXPECTED'].includes(up(c.state)) ? 'pending' : up(c.state) === 'SUCCESS' ? 'pass' : 'other';
    else if (up(c.status) !== 'COMPLETED') kind = 'pending';
    else kind = FAILED.has(up(c.conclusion)) ? 'fail' : up(c.conclusion) === 'SUCCESS' ? 'pass' : 'other';
    // Anyone who can post a commit status picks its link: only an https one is kept, as the page makes it clickable.
    const raw = String((status ? c.targetUrl : c.detailsUrl) ?? ''), url = /^https:\/\//i.test(raw) ? raw : '', m = url.match(RUN_URL);
    latest.set(key, { at, kind, name, url: url || null, runId: m ? Number(m[1]) : null, jobId: m?.[2] ? Number(m[2]) : null,
                      doneAt: ms(c.completedAt) ?? ms(c.startedAt), startedAt: ms(c.startedAt) });
  }
  const counts = { pass: 0, fail: 0, pending: 0 }, failing = [];
  let finishedAt = null, runningSince = null;
  for (const c of latest.values()) {
    if (c.kind === 'other') continue;
    counts[c.kind]++;
    if (c.kind === 'pending' && c.startedAt && c.startedAt < (runningSince ?? Infinity)) runningSince = c.startedAt;
    if (c.kind !== 'fail') continue;
    failing.push({ name: clip(c.name, 120), url: c.url, runId: c.runId, jobId: c.jobId });
    if (c.doneAt && c.doneAt > (finishedAt ?? 0)) finishedAt = c.doneAt;
  }
  const checks = counts.fail ? 'failing' : counts.pending ? 'running' : counts.pass ? 'passing' : 'none';
  return { checks, counts, failing, finishedAt, runningSince: counts.pending ? runningSince : null };
}

const SAY = {
  missing: 'The GitHub CLI (gh) was not found.',
  'signed-out': 'The GitHub CLI is not signed in.',
  timeout: 'GitHub did not answer in time.',
  'too-large': 'GitHub answered with more than the panel reads at once.',
  'no-cwd': 'The folder the panel runs gh from is missing, so gh could not start.',
  rate: 'GitHub\'s rate limit is used up for now. The panel asks again in 15 minutes.',
  'not-found': 'GitHub shows no such repository to this account.',
  offline: 'GitHub could not be reached.',
};
/**
 * Why a gh call failed, from what `run` resolved: null when it worked, else { kind, text }, with text a sentence to
 * show. Being signed out is exit code 4, which gh gives before it touches the network. A spawn fails with ENOENT both
 * when the binary is missing and when the cwd it was given is; pass that `cwd` and the second reads as 'no-cwd'.
 */
export function classify(r, { cwd } = {}) {
  const err = r?.err;
  if (!err) return null;
  const text = String(r.stderr ?? '');
  const kind = err.code === 'ENOENT' ? (cwd && !fs.existsSync(cwd) ? 'no-cwd' : 'missing')
    : err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'too-large'
    : err.code === 4 || /gh auth login|HTTP 401|Bad credentials/i.test(text) ? 'signed-out'
    : err.killed ? 'timeout'
    : /rate limit|HTTP 429|secondary rate/i.test(text) ? 'rate'
    : /Could not resolve to a Repository|HTTP 404/i.test(text) ? 'not-found'
    : /dial tcp|no such host|network is unreachable/i.test(text) ? 'offline'
    : 'error';
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? String(err.message ?? 'gh failed').split('\n')[0];
  return { kind, text: SAY[kind] ?? clip(line, 200) };
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
/**
 * The part of `gh run view --log-failed` worth reading: per failed step its last lines (ending just after its last
 * error, since a job's clean-up follows it), with the error lines themselves repeated on top. Each line of that log is
 * job, step and text, tab separated; the text starts with a timestamp.
 * @returns {{ text: string, steps: [{job, step, lines}], truncated: boolean }}
 */
export function trimLog(text, { perStep = 60, lineMax = 300, max = 12_000 } = {}) {
  const groups = new Map(), errors = [];
  let truncated = false;
  for (const raw of String(text ?? '').replace(/\uFEFF/g, '').split('\n')) { // each step's log starts with a BOM
    if (!raw.trim()) continue;
    const parts = raw.split('\t'), has = parts.length >= 3;
    const job = has ? parts[0].trim() : '', step = has && parts[1].trim() !== 'UNKNOWN STEP' ? parts[1].trim() : '';
    let line = (has ? parts.slice(2).join('\t') : raw).replace(STAMP, '').replace(ANSI, '').replace(/\r$/, '');
    if (/^##\[endgroup\]/.test(line)) continue;
    const err = line.match(/^##\[error\](.*)$/);
    line = err ? `Error: ${err[1]}` : line.replace(/^##\[\w+\]/, '');
    if (line.length > lineMax) { line = line.slice(0, lineMax) + '…'; truncated = true; }
    const key = `${job}\t${step}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { job, step, all: [], lastErr: -1 });
    if (err) { g.lastErr = g.all.length; if (errors.length < 10 && !errors.includes(line)) errors.push(line); }
    g.all.push(line);
  }
  let steps = [...groups.values()];
  if (steps.length > 12) { steps = steps.slice(0, 12); truncated = true; }
  for (const g of steps) {
    const end = g.lastErr >= 0 ? Math.min(g.all.length, g.lastErr + 4) : g.all.length;
    g.lines = g.all.slice(Math.max(0, end - perStep), end);
    if (g.lines.length < g.all.length) truncated = true;
  }
  const head = errors.length ? errors.join('\n') + '\n\n' : '';
  const label = (g) => [g.job, g.step].filter(Boolean).join(' › ') || 'log';
  const build = () => head + steps.map((g) => `== ${label(g)} ==\n${g.lines.join('\n')}`).join('\n\n');
  let out = build();
  if (out.length > max && steps.length) {
    // Too long still: every step gets an equal share, taken from its end.
    truncated = true;
    const share = Math.max(160, Math.floor((max - head.length) / steps.length) - 48);
    for (const g of steps) {
      let size = 0, from = g.lines.length;
      while (from > 0 && size + g.lines[from - 1].length + 1 <= share) size += g.lines[--from].length + 1;
      g.lines = g.lines.slice(Math.min(from, g.lines.length - 1));
    }
    out = build();
    if (out.length > max) out = out.slice(0, max - 1) + '…';
  }
  return { text: out, steps: steps.map((g) => ({ job: g.job, step: g.step, lines: g.lines.length })), truncated };
}

const runState = (r) => (r.status !== 'completed' ? 'running'
  : r.conclusion === 'success' ? 'passing'
  : ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion) ? 'failing' : 'other');
/** The worst of some states: failing, else running, else passing, else nothing to say. */
const worst = (states) => (states.includes('failing') ? 'failing' : states.includes('running') ? 'running' : states.includes('passing') ? 'passing' : null);

// ---------------------------------------------------------------- the watcher

/**
 * @param {object} deps
 * @param {string} [deps.file]   where the failures already told about are kept (0600); none: they last until a restart
 * @param {Function} deps.run    (cmd, args, opts) => Promise<{err, stdout, stderr}>, never rejects
 * @param {Function} deps.read   (file, max) => its text; may throw
 * @param {Function} [deps.ghPath]  () => the gh binary's path, or null when there is none
 * @param {Function} deps.targets   () => [{ sessionId, ws?, common, branch, at }]: every session on the board, with its
 *                                  workspace, its repository's shared git dir, its branch and when it was last active.
 *                                  Each workspace gets six repositories of its own (one several share counts towards
 *                                  each, and is polled once), so a busy workspace never crowds another out.
 * @param {Function} [deps.notify]  (title, text, { slug }) => void: a desktop notification about that repository
 * @param {Function} [deps.onEvent] ({ type, slug, text, branch?, pr?, runId?, url, sessions }) => void
 * @param {Function} [deps.onChange] () => void: state() or forSession() would now say something else
 * @param {string} [deps.cwd]    a folder outside any repository, so gh never looks at a repo's own config. If it is gone, calls fail as 'no-cwd', not as gh missing.
 */
export function createGithub({
  file, run, read, ghPath = () => 'gh', targets = () => [], notify = () => {}, onEvent = () => {}, onChange = () => {},
  cwd, env = process.env, now = Date.now, log = (m) => console.error(m), off = false, mine = false,
} = {}) {
  const ghEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  const repos = new Map();     // slug → what the last poll found
  const slugs = new Map();     // shared git dir → { at, slug }
  const defaults = new Map();  // slug → its default branch, for as long as this runs
  const seen = new Map();      // failure key → when it was first seen
  let status = off ? 'off' : 'unknown';
  let bin = null, binAt = -Infinity, authAt = -Infinity, refreshedAt = -Infinity;
  let polling = false, stopped = false, lastWatched = false, seenDirty = false, dirty = false;
  let more = 0, order = [], cached = null;
  let moreBy = new Map();      // workspace → how many of its repositories are not watched
  // With `mine`: your own open pull requests across GitHub, by repository, from one search every few minutes, and your login.
  let mineMap = new Map(), mineAt = -Infinity, me = null;

  if (file && !off) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))?.seen;
      if (saved && typeof saved === 'object') for (const [k, at] of Object.entries(saved)) if (Number.isFinite(at)) seen.set(k, at);
    } catch { /* no file yet, or not ours: start empty */ }
  }
  /** Keep the newest and write them privately: a tmp of its own, then a rename. */
  function save() {
    if (!file || !seenDirty) return;
    seenDirty = false;
    const newest = [...seen].sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX);
    seen.clear();
    for (const [k, at] of newest) seen.set(k, at);
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, seen: Object.fromEntries(seen) }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
      log(`github: could not write ${file} (${e?.code ?? 'error'}).`);
    }
  }
  const touch = () => { dirty = true; cached = null; };
  function setStatus(s) { if (status !== s) { status = s; touch(); } }
  const mark = (key) => { if (!seen.has(key)) { seen.set(key, now()); seenDirty = true; } };
  const tell = (fn, ...args) => { try { fn(...args); } catch (e) { log(`github: ${e?.message ?? e}`); } };

  const gh = (args, opts = {}) => run(bin, args, { cwd, env: ghEnv, timeout: 12_000, ...opts });
  async function ghJson(args) {
    const r = await gh(args), bad = classify(r, { cwd });
    if (bad) return { bad };
    try { return { data: JSON.parse(r.stdout) }; } catch { return { bad: { kind: 'error', text: 'The GitHub CLI answered with something the panel could not read.' } }; }
  }

  function slugFor(common) {
    if (typeof common !== 'string' || !common) return null;
    const t = now(), hit = slugs.get(common);
    if (hit && t - hit.at < MIN) return hit.slug;
    const slug = slugOf(common, read);
    slugs.set(common, { at: t, slug });
    if (slugs.size > 500) slugs.delete(slugs.keys().next().value);
    return slug;
  }
  const newRepo = (slug) => ({
    slug, url: `https://github.com/${slug}`, defaultBranch: defaults.get(slug) ?? null, checkedAt: null, error: null,
    prs: [], runs: [], merged: [], mergedAll: [], byBranch: new Map(), info: new Map(), known: new Map(), mainWas: new Map(),
    main: null, running: false, baselined: false, polls: 0, lastAt: -Infinity, errorUntil: 0, backoff: 0,
  });

  /** The repositories to watch now: those the board's sessions work in, most recently active first, at most six per
   *  workspace. */
  function track() {
    const groups = new Map(), byWs = new Map(); // byWs: workspace → slug → when its sessions there were last active
    for (const t of targets() ?? []) {
      const slug = slugFor(t?.common);
      if (!slug) continue;
      let g = groups.get(slug);
      if (!g) groups.set(slug, g = { slug, commons: new Set(), branches: new Map(), at: 0 });
      g.commons.add(t.common);
      g.at = Math.max(g.at, Number(t.at) || 0);
      const w = typeof t.ws === 'string' ? t.ws : '';
      let inWs = byWs.get(w);
      if (!inWs) byWs.set(w, inWs = new Map());
      inWs.set(slug, Math.max(inWs.get(slug) ?? 0, Number(t.at) || 0));
      if (typeof t.branch === 'string' && t.branch) {
        const on = g.branches.get(t.branch) ?? [];
        if (t.sessionId && !on.includes(t.sessionId)) on.push(t.sessionId);
        g.branches.set(t.branch, on);
      }
    }
    const all = [...groups.values()].sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug));
    // Each workspace's six most recently active (with one workspace, the six of the board, as before workspaces).
    const kept = new Set();
    for (const inWs of byWs.values())
      for (const [slug] of [...inWs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_REPOS)) kept.add(slug);
    const keep = all.filter((g) => kept.has(g.slug)), over = all.length - keep.length;
    const by = new Map([...byWs].map(([w, inWs]) => [w, [...inWs.keys()].filter((slug) => !kept.has(slug)).length]));
    // Then the repositories where your own pull requests are open and no agent works.
    if (mine) keep.push(...[...mineMap.keys()].filter((slug) => !keep.some((g) => g.slug === slug)).sort().slice(0, MAX_MINE)
      .map((slug) => groups.get(slug) ?? { slug, commons: new Set(), branches: new Map(), at: 0, mineOnly: true }));
    const names = keep.map((g) => g.slug);
    for (const slug of [...repos.keys()]) if (!names.includes(slug)) repos.delete(slug);
    for (const slug of names) if (!repos.has(slug)) repos.set(slug, newRepo(slug));
    if (names.join('\n') !== order.join('\n') || more !== over || JSON.stringify([...by]) !== JSON.stringify([...moreBy])) { order = names; more = over; moreBy = by; touch(); }
    return keep;
  }

  const pace = (repo, watched) => (watched ? (repo.running ? 20_000 : MIN) : (repo.running ? MIN : 5 * MIN));
  const due = (repo, watched, t) => (repo.errorUntil ? t >= repo.errorUntil : t - repo.lastAt >= pace(repo, watched));

  /**
   * One beat of the clock: polls the repositories that are due, one after another. `watched` says a page is open, which
   * quickens the pace. Resolves when this beat's polls are done; a beat that arrives during another does nothing.
   */
  async function tick({ watched = false } = {}) {
    if (off || stopped) return;
    lastWatched = watched;
    try {
      // It runs off a timer: whatever goes wrong is logged, never thrown at the caller.
      let groups = track();
      if (polling || (!groups.length && !mine)) return;
      const t = now();
      if (!bin) {
        if (status === 'missing' && t - binAt < 10 * MIN) return;
        binAt = t;
        try { bin = ghPath() || null; } catch { bin = null; }
        if (!bin) { setStatus('missing'); return; }
      }
      if (status === 'signed-out' && t - authAt < 5 * MIN) return;
      polling = true;
      try {
        if (mine) { await findMine(watched); groups = track(); }
        for (const g of groups) {
          if (stopped) break;
          const repo = repos.get(g.slug);
          if (!repo || !due(repo, watched, now())) continue;
          try { await poll(repo, g); } catch (e) {
            log(`github: polling ${g.slug} failed (${e?.message ?? e}).`);
            failed(repo, { kind: 'error', text: 'The GitHub CLI answered with something the panel could not read.' });
          }
          touch();
          if (status === 'missing' || status === 'signed-out') break; // the others would only say the same
        }
      } finally { polling = false; }
      save();
    } catch (e) {
      log(`github: ${e?.message ?? e}`);
    } finally {
      if (dirty) { dirty = false; tell(onChange); }
    }
  }

  /** Your own open pull requests across GitHub, from one search: every 3 minutes while a page is open, else every 15. */
  async function findMine(watched) {
    const t = now();
    if (t - mineAt < (watched ? 3 * MIN : 15 * MIN)) return;
    mineAt = t;
    const r = await ghJson(['search', 'prs', '--author', '@me', '--state', 'open', '--limit', '100', '--json', 'repository,number,author']);
    if (r.bad) {
      if (r.bad.kind === 'missing') { bin = null; binAt = now(); setStatus('missing'); }
      else if (r.bad.kind === 'signed-out') { authAt = now(); setStatus('signed-out'); }
      return; // anything else: keep what the last search found, and ask again on the next round
    }
    if (!Array.isArray(r.data)) return;
    const next = new Map();
    for (const p of r.data) {
      const slug = String(p?.repository?.nameWithOwner ?? ''), [o, n, extra] = slug.split('/');
      if (extra !== undefined || !OWNER.test(o ?? '') || !NAME.test(n ?? '') || n === '.' || n === '..' || !Number.isInteger(p.number)) continue;
      if (!me && typeof p.author?.login === 'string') me = p.author.login;
      if (!next.has(slug)) next.set(slug, new Set());
      next.get(slug).add(p.number);
    }
    const sig = (m) => [...m].map(([k, v]) => `${k}:${[...v].sort().join(',')}`).sort().join(' ');
    if (sig(next) !== sig(mineMap)) touch();
    mineMap = next;
  }

  function failed(repo, bad) {
    if (bad.kind === 'missing') { bin = null; binAt = now(); setStatus('missing'); return; }
    if (bad.kind === 'signed-out') { authAt = now(); setStatus('signed-out'); return; }
    // Any other answer means gh ran and got past its own sign-in check (exit 4 comes before the network): it is there and
    // signed in, so a stale "run gh auth login" must not stay up, nor hold the next polls to the signed-out pace.
    if (bad.kind !== 'no-cwd') setStatus('ok');
    repo.backoff = bad.kind === 'rate' ? 15 * MIN : bad.kind === 'not-found' ? 60 * MIN : Math.min(repo.backoff ? repo.backoff * 2 : MIN, 15 * MIN);
    repo.errorUntil = now() + repo.backoff;
    repo.error = { kind: bad.kind, text: bad.text };
  }
  /** New to tell about: not told before, and either found while watching or recent enough to have been missed by a restart. */
  const isNew = (repo, key, finishedAt, t) => !seen.has(key) && (repo.baselined || (finishedAt != null && t - finishedAt < FRESH_MS));

  function fileDefault(commons) {
    for (const common of commons) {
      try {
        const ref = read(path.join(common, 'refs', 'remotes', 'origin', 'HEAD'), 4096).match(/^ref:\s*refs\/remotes\/origin\/(.+)$/m)?.[1]?.trim();
        if (ref) return ref;
      } catch { /* a repo made with git init has none */ }
    }
    return null;
  }

  async function poll(repo, g) {
    const R = `github.com/${repo.slug}`, slug = repo.slug;
    if (!repo.defaultBranch) {
      repo.defaultBranch = fileDefault(g.commons);
      if (!repo.defaultBranch) {
        const r = await ghJson(['repo', 'view', R, '--json', 'defaultBranchRef']);
        if (r.bad) return failed(repo, r.bad);
        repo.defaultBranch = r.data?.defaultBranchRef?.name || null; // an empty repository has none
      }
      if (repo.defaultBranch) defaults.set(slug, repo.defaultBranch);
    }
    const [open, runs] = await Promise.all([
      ghJson(['pr', 'list', '-R', R, '--state', 'open', '--limit', String(OPEN_LIMIT), '--json',
        'number,title,url,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt' + (mine ? ',author' : '')]),
      // A repository watched only for your pull requests has no agent on its default branch: its runs are not asked for.
      repo.defaultBranch && !g.mineOnly ? ghJson(['run', 'list', '-R', R, '--branch', repo.defaultBranch, '--limit', '30', '--json',
        'databaseId,workflowName,displayTitle,status,conclusion,headBranch,headSha,event,url,createdAt,updatedAt,attempt']) : { data: [] },
    ]);
    const bad = open.bad ?? runs.bad ?? (Array.isArray(open.data) && Array.isArray(runs.data) ? null
      : { kind: 'error', text: 'The GitHub CLI answered with something the panel could not read.' });
    if (bad) return failed(repo, bad);
    setStatus('ok');

    const t = now(), alerts = [], events = [], info = new Map();
    const main = repo.defaultBranch;

    // Pull requests of the branches agents are on, and with `mine` your own. One from a fork is somebody else's branch of
    // the same name, unless it is yours.
    const prs = [], seenOpen = new Set(open.data.map((p) => p.number)), myNums = mineMap.get(slug) ?? new Set();
    for (const p of open.data) {
      const agent = !p.isCrossRepository && g.branches.has(p.headRefName), own = mine && (myNums.has(p.number) || (me != null && p.author?.login === me));
      if (!agent && !own) continue;
      const roll = rollup(p.statusCheckRollup), sessions = agent ? g.branches.get(p.headRefName) : [];
      const pr = { number: p.number, title: clip(p.title, 120), url: p.url, branch: p.headRefName, sha: p.headRefOid, draft: Boolean(p.isDraft),
                   checks: roll.checks, counts: roll.counts, failing: roll.failing.slice(0, 5), mergeable: p.mergeable ?? null,
                   mergeState: p.mergeStateStatus ?? null, review: p.reviewDecision || null, updatedAt: ms(p.updatedAt),
                   runningSince: roll.runningSince, mine: Boolean(own), sessions };
      prs.push(pr);
      const was = repo.known.get(pr.number), key = `${slug}#pr${pr.number}@${pr.sha}`;
      const ev = (type, text, extra = {}) => events.push({ type, slug, text, branch: pr.branch, pr: pr.number, url: pr.url, sessions, ...extra });
      if (!was && repo.baselined) ev('pr-opened', `Pull request #${pr.number} was opened for ${pr.branch} in ${slug}.`);
      if (pr.checks === 'failing') {
        if (isNew(repo, key, roll.finishedAt, t)) {
          const what = pr.failing[0]?.name ?? 'A check';
          alerts.push(`${slug}: ${what} failed on ${pr.branch} (#${pr.number}).`);
          ev('ci-failed', `${what} failed on #${pr.number} (${pr.branch}) in ${slug}.`, { runId: pr.failing[0]?.runId ?? null });
        }
        mark(key);
      } else if (pr.checks === 'passing') {
        if (seen.delete(key)) seenDirty = true; // a later failure on this same commit is news again
        if (was?.checks === 'failing') ev('ci-recovered', `Checks pass again on #${pr.number} (${pr.branch}) in ${slug}.`);
      }
      // While a re-run is going it is still the failure it was: only passing clears that.
      repo.known.set(pr.number, { branch: pr.branch, url: pr.url, sessions, mine: pr.mine, checks: pr.checks === 'running' && was?.checks === 'failing' ? 'failing' : pr.checks });
      for (const f of pr.failing) if (f.runId) info.set(String(f.runId), { workflow: f.name, branch: pr.branch, pr: pr.number, url: f.url ?? pr.url, on: 'pr', jobId: f.jobId });
    }

    // Ones we followed that are no longer open were merged or closed: the merged list says which.
    const gone = open.data.length < OPEN_LIMIT ? [...repo.known.keys()].filter((n) => !seenOpen.has(n)) : [];
    for (const [n, k] of repo.known) if (seenOpen.has(n) && !g.branches.has(k.branch) && !k.mine) repo.known.delete(n); // its agent moved on
    if (repo.polls % 5 === 0 || gone.length) {
      const m = await ghJson(['pr', 'list', '-R', R, '--state', 'merged', '--limit', '15', '--json', 'number,title,url,headRefName,baseRefName,mergedAt,mergeCommit' + (mine ? ',author' : '')]);
      if (!m.bad && Array.isArray(m.data)) {
        repo.mergedAll = m.data.map((p) => ({ number: p.number, title: clip(p.title, 120), url: p.url, branch: p.headRefName, mergedAt: ms(p.mergedAt), sha: p.mergeCommit?.oid ?? null,
                                              mine: me != null && p.author?.login === me }))
          .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0));
        for (const n of gone) {
          const k = repo.known.get(n), merged = repo.mergedAll.some((p) => p.number === n);
          repo.known.delete(n);
          events.push({ type: merged ? 'pr-merged' : 'pr-closed', slug, branch: k.branch, pr: n, url: k.url, sessions: k.sessions,
                        text: merged ? `Pull request #${n} (${k.branch}) was merged in ${slug}.` : `Pull request #${n} (${k.branch}) was closed without merging in ${slug}.` });
        }
      } // not answered: they stay followed, and the next poll asks again
    }

    // What ran on the default branch. A run on a merge commit belongs to that pull request.
    const all = runs.data.filter((r) => MAIN_EVENTS.has(r.event)).map((r) => {
      const m = repo.mergedAll.find((p) => p.sha && p.sha === r.headSha);
      return { id: r.databaseId, attempt: r.attempt ?? 1, workflow: clip(r.workflowName || r.displayTitle || 'A workflow', 120), title: clip(r.displayTitle, 120),
               state: runState(r), event: r.event, sha: r.headSha ?? null, url: r.url, at: ms(r.updatedAt) ?? ms(r.createdAt),
               started: ms(r.createdAt) ?? 0, pr: m?.number ?? null, branch: m?.branch ?? null, sessions: m ? g.branches.get(m.branch) ?? [] : [] };
    }).sort((a, b) => b.started - a.started || b.id - a.id);
    const latest = new Map(), lastDone = new Map();
    for (const r of all) {
      if (!latest.has(r.workflow)) latest.set(r.workflow, r);
      if (!lastDone.has(r.workflow) && (r.state === 'passing' || r.state === 'failing')) lastDone.set(r.workflow, r);
      if (r.state !== 'failing') continue;
      info.set(String(r.id), { workflow: r.workflow, branch: main, pr: r.pr, url: r.url, on: 'main', jobId: null });
      if (!NOTIFY_EVENTS.has(r.event)) continue;
      const key = `${slug}#run${r.id}.${r.attempt}`, after = r.pr ? ` after #${r.pr}` : '';
      if (isNew(repo, key, r.at, t)) {
        alerts.push(`${slug}: ${r.workflow} failed on ${main}${after}.`);
        events.push({ type: 'main-failed', slug, branch: main, pr: r.pr, runId: r.id, url: r.url, sessions: r.sessions, text: `${r.workflow} failed on ${main} in ${slug}${after}.` });
      }
      mark(key);
    }
    for (const [workflow, r] of lastDone) {
      if (repo.mainWas.get(workflow) === 'failing' && r.state === 'passing') {
        events.push({ type: 'main-recovered', slug, branch: main, pr: r.pr, runId: r.id, url: r.url, sessions: r.sessions, text: `${workflow} passes again on ${main} in ${slug}.` });
      }
      repo.mainWas.set(workflow, r.state);
    }
    const shown = [...latest.values()].slice(0, 8); // each workflow's newest run
    const merges = shown.filter((r) => NOTIFY_EVENTS.has(r.event));

    Object.assign(repo, {
      prs, runs: shown, merged: repo.mergedAll.slice(0, 5), byBranch: new Map(prs.map((p) => [p.branch, p])), info,
      main: worst((merges.length ? merges : shown).map((r) => r.state)),
      running: prs.some((p) => p.checks === 'running') || shown.some((r) => r.state === 'running'),
      error: null, errorUntil: 0, backoff: 0, lastAt: t, checkedAt: t, baselined: true, polls: repo.polls + 1, mineOnly: Boolean(g.mineOnly),
    });
    for (const a of alerts.slice(0, 3)) tell(notify, TITLE, a, { slug });
    if (alerts.length > 3) tell(notify, TITLE, `${alerts.length - 3} more ${alerts.length - 3 === 1 ? 'check' : 'checks'} failed in ${slug}.`, { slug });
    for (const e of events) tell(onEvent, e);
  }

  /** Ask again now, on the next beat's terms. At most once in ten seconds; resolves when that poll is done. */
  function refresh() {
    const t = now();
    if (off || stopped || t - refreshedAt < 10_000) return Promise.resolve();
    refreshedAt = t;
    for (const repo of repos.values()) { repo.lastAt = -Infinity; if (repo.error?.kind !== 'rate') repo.errorUntil = 0; }
    authAt = binAt = -Infinity;
    return tick({ watched: lastWatched });
  }

  /** What the page shows: `snap.github`. The same object until something changes. */
  function state() {
    if (cached) return cached;
    return cached = {
      gh: status, hint: HINTS[status] ?? null, more,
      repos: order.map((slug) => repos.get(slug)).filter(Boolean).map((r) => ({
        slug: r.slug, url: r.url, defaultBranch: r.defaultBranch, checkedAt: r.checkedAt, error: r.error, prs: r.prs, mineOnly: Boolean(r.mineOnly),
        runs: r.runs.map(({ id, attempt, workflow, title, state, event, sha, url, at, started, pr, sessions }) => ({ id, attempt, workflow, title, state, event, sha, url, at, started, pr, sessions })),
        merged: r.merged,
      })),
    };
  }

  /**
   * GitHub's side of one session, from its repository's shared git dir and its branch: its pull request, how the
   * default branch stands, and the failed run it could be handed. Null when its repository is not watched.
   */
  function forSession(common, branch) {
    if (off) return null;
    const slug = slugFor(common), repo = slug ? repos.get(slug) : null;
    if (!repo) return null;
    // The default branch is where pull requests merge, not one of their heads: a session there has none.
    const p = typeof branch === 'string' && branch !== repo.defaultBranch ? repo.byBranch.get(branch) ?? null : null;
    const check = p?.checks === 'failing' ? p.failing.find((f) => f.runId) : null;
    // A broken default branch is its to fix when it works there, or when the pull request it wrote was the merge.
    const broke = check ? null : repo.runs.find((r) => r.state === 'failing' && branch && (branch === repo.defaultBranch || r.branch === branch));
    return {
      slug, url: repo.url,
      pr: p && { number: p.number, url: p.url, draft: p.draft, checks: p.checks, failing: p.failing.slice(0, 3).map((f) => f.name), mergeState: p.mergeState, review: p.review },
      main: repo.main,
      failed: check ? { runId: check.runId, jobId: check.jobId, workflow: check.name, url: check.url, on: 'pr' }
        : broke ? { runId: broke.id, jobId: null, workflow: broke.workflow, url: broke.url, on: 'main' } : null,
    };
  }

  /** Whether that run is one the last poll showed as failed: the only ones a log is fetched for. */
  const knows = (slug, runId) => Boolean(repos.get(slug)?.info.has(String(runId)));

  /**
   * A failed run's log, cut down to what failed, and the message that would hand it to an agent.
   * @returns {Promise<{ok: true, text, steps, truncated, url, message} | {ok: false, error, url?}>}
   */
  async function failedLog({ slug, runId, jobId } = {}) {
    const what = repos.get(slug)?.info.get(String(runId));
    if (off || !what) return { ok: false, error: 'That run is not one the panel is showing as failed.' };
    if (!bin) return { ok: false, error: HINTS.missing };
    const R = `github.com/${slug}`, url = what.url, opts = { timeout: 60_000, maxBuffer: 64 << 20 };
    const job = Number.isSafeInteger(Number(jobId ?? what.jobId)) && Number(jobId ?? what.jobId) > 0 ? String(Number(jobId ?? what.jobId)) : null;
    const whole = ['run', 'view', String(Number(runId)), '-R', R, '--log-failed'];
    let r = await gh(job ? ['run', 'view', '-R', R, '--job', job, '--log-failed'] : whole, opts);
    if (job && r.err && r.err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') r = await gh(whole, opts); // one job's log can be asked for too early
    const bad = classify(r, { cwd });
    if (bad) {
      if (bad.kind === 'missing') { bin = null; binAt = now(); setStatus('missing'); }
      const error = bad.kind === 'too-large' ? 'That log is too large to fetch here. Open it on GitHub.'
        : /still in progress|still running|in progress/i.test(r.stderr) ? 'That run is still going. Its log is ready once it finishes.'
        : /log not found/i.test(r.stderr) ? 'GitHub has no log for that run: it failed before a job started. Open it on GitHub.'
        : bad.text;
      return { ok: false, error, url };
    }
    const cut = trimLog(r.stdout);
    if (!cut.text.trim()) return { ok: false, error: 'That run\'s log names no failed step. Open it on GitHub.', url };
    const where = what.on === 'pr' ? `on ${what.branch} (pull request #${what.pr})` : `on ${what.branch}${what.pr ? ` after pull request #${what.pr} was merged` : ''}`;
    const message = `${what.workflow} failed ${where} in ${slug}. This is the failing part of its log${cut.truncated ? ', shortened' : ''}. `
      + `Find the cause and fix it.\n\n\`\`\`\n${cut.text.replace(/```/g, "'''")}\n\`\`\`\n\nThe full run: ${url}`;
    return { ok: true, text: cut.text, steps: cut.steps, truncated: cut.truncated, url, message };
  }

  /** How many repositories workspace `ws`'s sessions work in that are not watched: its own count, never another's. */
  const moreIn = (ws) => moreBy.get(typeof ws === 'string' ? ws : '') ?? 0;

  /** Stop polling and write what is unsaved. */
  function stop() { stopped = true; save(); }

  return { tick, refresh, state, forSession, failedLog, knows, moreIn, stop };
}
