// World: a universe your agents' work pays for (docs/superpowers/specs/2026-10-21-world-design.md).
//
// Credit is earned per local calendar day from the tokens the shown profile's sessions use and the lines in your own
// commits; lines removed multiply it. Only work after World's first open counts.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A local calendar day, YYYY-MM-DD. */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Removing pays: 1 with nothing removed, up to 4 when a day only removes. */
export function multiplier(added, removed) {
  const all = added + removed;
  return all > 0 ? Math.round((1 + 3 * removed / all) * 10) / 10 : 1;
}

export function dayCredit({ added = 0, removed = 0, tokens = 0 }) {
  return Math.round((added / 10 + tokens / 10_000) * multiplier(added, removed));
}

/** How far Home and the lit map have grown, 0..1: quick at first, slower later, never done. */
export const grown = (earned) => 1 - Math.exp(-Math.max(0, earned) / 30_000);

/** A commit as you wrote it: a rebase, an amend or a cherry-pick keeps its author time and subject. */
export const commitKey = (authorTimeSec, subject) =>
  `${authorTimeSec}:${crypto.createHash('sha1').update(subject).digest('hex').slice(0, 12)}`;

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'Gemfile.lock',
  'poetry.lock', 'composer.lock', 'go.sum']);
export const countsFile = (file) => !LOCKFILES.has(path.basename(file));

/** A file's lines in one commit count at most this many each way (generated files would swamp everything else). */
export const FILE_CAP = 2000;

// ---------------------------------------------------------------- tokens

const CHUNK = 4 << 20;
const KEEP_IDS = 50;
/** The tokens one reply used: what was sent and written, not what came from the prompt cache. */
const tokensOf = (u) => (u.output_tokens ?? 0) + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Reads what a transcript gained since `seen` (whole lines only) and returns the tokens per day it adds, counting each
 *  reply once (Claude Code writes one reply as several entries that repeat its message id and usage), and the folders
 *  those entries worked in or edited files in. A file untouched since before World started is skipped, not read. */
export function readTokens(file, seen, startedAt) {
  const tokens = {}, dirs = new Set(), ids = [...(seen?.ids ?? [])];
  const st = fs.statSync(file);
  if (!seen && st.mtimeMs < startedAt) return { state: { offset: st.size, ids: [] }, tokens, dirs: [] };
  let offset = seen?.offset ?? 0;
  if (offset > st.size) return { state: { offset: st.size, ids }, tokens, dirs: [] }; // shrank: never recount
  const fd = fs.openSync(file, 'r');
  try {
    // Split on newline bytes, never on decoded text: a chunk can end inside a multi-byte character.
    let rest = Buffer.alloc(0);
    while (offset + rest.length < st.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - offset - rest.length));
      const n = fs.readSync(fd, buf, 0, buf.length, offset + rest.length);
      if (!n) break;
      const bytes = Buffer.concat([rest, buf.subarray(0, n)]), end = bytes.lastIndexOf(0x0a);
      if (end < 0) { rest = bytes; continue; }
      for (const line of bytes.toString('utf8', 0, end).split('\n')) count(line);
      offset += end + 1;
      rest = bytes.subarray(end + 1);
    }
  } finally { fs.closeSync(fd); }
  return { state: { offset, ids: ids.slice(-KEEP_IDS) }, tokens, dirs: [...dirs] };

  function count(line) {
    if (!line.includes('"usage"') && !line.includes('"cwd"')) return;
    let d;
    try { d = JSON.parse(line); } catch { return; }
    const at = Date.parse(d.timestamp);
    if (!(at >= startedAt)) return;
    if (typeof d.cwd === 'string' && path.isAbsolute(d.cwd)) dirs.add(d.cwd);
    for (const b of d.type === 'assistant' && Array.isArray(d.message?.content) ? d.message.content : []) {
      const f = b?.type === 'tool_use' && EDITS.has(b.name) ? b.input?.file_path ?? b.input?.notebook_path : null;
      if (typeof f === 'string' && path.isAbsolute(f)) dirs.add(path.dirname(f));
    }
    const u = d.type === 'assistant' ? d.message?.usage : null, id = d.message?.id;
    if (!u || typeof u !== 'object' || (id && ids.includes(id))) return;
    if (id) ids.push(id);
    const day = dayKey(at);
    tokens[day] = (tokens[day] ?? 0) + tokensOf(u);
  }
}

// ---------------------------------------------------------------- commits

/** Your commits in `git log --all --no-merges --format=%x1e%H%x1f%at%x1f%ae%x1f%ce%x1f%s --numstat` output: authored
 *  and committed by `email` (a squash or merge GitHub made for you has GitHub as committer, and isn't counted again),
 *  from `sinceSec` on, with their counted lines. */
export function parseLog(text, email, sinceSec = 0) {
  const me = email.toLowerCase(), out = [];
  for (const rec of text.split('\x1e').slice(1)) {
    const [head, ...stat] = rec.split('\n');
    const [, at, author, committer, ...subject] = head.split('\x1f');
    if (author?.toLowerCase() !== me || committer?.toLowerCase() !== me || !(Number(at) >= sinceSec)) continue;
    let added = 0, removed = 0;
    for (const line of stat) {
      const [a, r, ...file] = line.split('\t');
      if (!file.length || a === '-' || !countsFile(file.join('\t'))) continue; // binary files show as -
      added += Math.min(FILE_CAP, Number(a) || 0);
      removed += Math.min(FILE_CAP, Number(r) || 0);
    }
    out.push({ key: commitKey(Number(at), subject.join('\x1f')), day: dayKey(Number(at) * 1000), added, removed });
  }
  return out;
}

// ---------------------------------------------------------------- the store

const LOG_FORMAT = '--format=%x1e%H%x1f%at%x1f%ae%x1f%ce%x1f%s';
const WINDOW_DAYS = 30;
const blank = () => ({ added: 0, removed: 0, tokens: 0, commits: 0 });
const VERSION = 2;
const valid = (st) => st && st.v === VERSION && Number.isFinite(st.startedAt) && [st.files, st.tokens, st.lines].every((o) => o && typeof o === 'object')
  && [st.repos, st.purchases].every(Array.isArray);
/** The most two counts of one repository's day have seen. */
const most = (a, b) => ({ added: Math.max(a.added, b.added), removed: Math.max(a.removed, b.removed), commits: Math.max(a.commits, b.commits) });
/** A folder's true path. The Mac's disk ignores case, and git names a repository the way it was asked, so one repository
 *  can turn up as ~/Documents/x and ~/documents/x. */
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };


/** The one World on this Mac, kept in `file`, fed by every profile's sessions (`configDirs`: the profile folders, or a
 *  function returning them). Nothing is written until open(). `run` is the server's execFile wrapper and `gitPlace` its
 *  folder → git checkout lookup. */
export function createWorld({ file, configDirs, gitPlace, run, now = Date.now }) {
  let st = null, memo = null;
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (valid(loaded)) st = loaded;
    else fs.renameSync(file, `${file}.bad-${now()}`); // kept for a look, never overwritten
  } catch {}
  if (st) { // a World that found one repository under two spellings counted it twice: keep it once, at its most
    const lines = {};
    for (const [repo, perDay] of Object.entries(st.lines)) {
      const kept = (lines[real(repo)] ??= {});
      for (const [day, c] of Object.entries(perDay)) kept[day] = kept[day] ? most(kept[day], c) : c;
    }
    st.lines = lines;
    st.repos = [...new Set(st.repos.map(real))];
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, file);
    memo = null;
  }

  /** Every transcript of every profile: sessions, and their subagents. */
  function transcripts() {
    const out = [], list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
    for (const dir of typeof configDirs === 'function' ? configDirs() : configDirs) {
      const root = path.join(dir, 'projects');
      for (const p of list(root)) {
        if (!p.isDirectory()) continue;
        for (const e of list(path.join(root, p.name))) {
          const f = path.join(root, p.name, e.name);
          if (e.isFile() && e.name.endsWith('.jsonl')) out.push(f);
          else if (e.isDirectory()) for (const s of list(path.join(f, 'subagents'))) if (s.isFile() && s.name.endsWith('.jsonl')) out.push(path.join(f, 'subagents', s.name));
        }
      }
    }
    return out;
  }

  async function scanTokens() {
    let changed = false, read = 0;
    const repos = new Set(st.repos), seenDirs = new Map();
    for (const f of transcripts()) {
      const seen = st.files[f];
      let size, mtimeMs;
      try { ({ size, mtimeMs } = fs.statSync(f)); } catch { continue; }
      if (seen ? seen.offset === size : mtimeMs < st.startedAt) continue; // nothing new, or from before World
      let r;
      try { r = readTokens(f, seen, st.startedAt); } catch { continue; }
      if (++read % 8 === 0) await new Promise((resolve) => setImmediate(resolve)); // let the panel answer in between
      st.files[f] = r.state;
      changed = true;
      for (const [day, n] of Object.entries(r.tokens)) st.tokens[day] = (st.tokens[day] ?? 0) + n;
      for (const dir of r.dirs) {
        if (!seenDirs.has(dir)) { const repo = gitPlace(dir)?.repo; seenDirs.set(dir, repo ? real(repo) : null); }
        const repo = seenDirs.get(dir);
        if (repo) repos.add(repo);
      }
    }
    st.repos = [...repos];
    return changed;
  }

  /** Each repository's lines per day are the most any scan has seen there. A scan counts what is reachable now (your
   *  commits on every branch and remote, not the stash), so a branch deleted after a squash merge keeps the credit it
   *  had, and an amended, reworded or rebased commit replaces its old count instead of adding to it. */
  async function scanCommits() {
    const noEmail = [], failed = [], sinceAuthor = Math.floor(st.startedAt / 1000);
    const since = Math.max(sinceAuthor, Math.floor(now() / 1000) - WINDOW_DAYS * 86_400); // older days keep their counts
    for (const repo of st.repos) {
      if (!fs.existsSync(repo)) continue;
      const conf = await run('git', ['-C', repo, 'config', 'user.email'], { timeout: 10_000 });
      const email = conf.stdout.trim();
      if (!email) { (conf.err?.killed ? failed : noEmail).push(repo); continue; }
      const r = await run('git', ['-C', repo, 'log', '--no-show-signature', '--no-textconv', '--no-ext-diff', '--no-merges',
        '-F', '-i', `--author=<${email}>`, `--committer=<${email}>`, `--since=${since}`, '--exclude=refs/stash', '--all',
        LOG_FORMAT, '--numstat'], { timeout: 10_000 });
      if (r.err) { failed.push(repo); continue; } // keep what it counted before
      const days = {}, keys = new Set();
      for (const c of parseLog(r.stdout, email, sinceAuthor)) {
        if (keys.has(c.key)) continue; // an older version of a commit already counted (git lists the newest first)
        keys.add(c.key);
        const x = (days[c.day] ??= { added: 0, removed: 0, commits: 0 });
        x.added += c.added; x.removed += c.removed; x.commits++;
      }
      const kept = (st.lines[repo] ??= {});
      for (const [day, x] of Object.entries(days)) kept[day] = most(kept[day] ?? { added: 0, removed: 0, commits: 0 }, x);
    }
    st.noEmail = noEmail;
    st.gitFailed = failed;
  }

  return {
    started: () => Boolean(st),
    open() {
      if (st) return;
      st = { v: VERSION, startedAt: now(), seed: crypto.randomInt(2 ** 31), files: {}, tokens: {}, lines: {}, repos: [], noEmail: [], gitFailed: [], purchases: [] };
      save();
    },
    async scan({ git = true } = {}) {
      if (!st) return;
      const changed = await scanTokens();
      if (git) await scanCommits();
      if (changed || git) save();
    },
    summary() {
      if (!st) return { started: false };
      const today = dayKey(now());
      if (memo?.today === today) return memo.summary;
      const days = {};
      for (const [d, n] of Object.entries(st.tokens)) (days[d] ??= blank()).tokens += n;
      for (const perDay of Object.values(st.lines)) for (const [d, c] of Object.entries(perDay)) {
        const x = (days[d] ??= blank());
        x.added += c.added; x.removed += c.removed; x.commits += c.commits;
      }
      const earned = Object.values(days).reduce((sum, x) => sum + dayCredit(x), 0);
      const spent = st.purchases.reduce((sum, p) => sum + (p.price ?? 0), 0), t = days[today] ?? blank();
      const summary = { started: true, startedAt: st.startedAt, seed: st.seed, earned, spent, balance: earned - spent, grown: grown(earned),
        today: { day: today, commits: t.commits, added: t.added, removed: t.removed, multiplier: multiplier(t.added, t.removed), tokens: t.tokens, credit: dayCredit(t) },
        noEmail: st.noEmail ?? [], gitFailed: st.gitFailed ?? [] };
      memo = { today, summary };
      return summary;
    },
  };
}
