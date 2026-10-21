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

/** Reads what a transcript gained since `seen` (whole lines only) and returns the tokens per day it adds, counting each
 *  reply once (Claude Code writes one reply as several entries that repeat its message id and usage), and the folders
 *  those entries worked in. A file untouched since before World started is skipped, not read. */
export function readTokens(file, seen, startedAt) {
  const tokens = {}, cwds = new Set(), ids = [...(seen?.ids ?? [])];
  const st = fs.statSync(file);
  if (!seen && st.mtimeMs < startedAt) return { state: { offset: st.size, ids: [] }, tokens, cwds: [] };
  let offset = seen?.offset ?? 0;
  if (offset > st.size) return { state: { offset: st.size, ids }, tokens, cwds: [] }; // shrank: never recount
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
  return { state: { offset, ids: ids.slice(-KEEP_IDS) }, tokens, cwds: [...cwds] };

  function count(line) {
    if (!line.includes('"usage"') && !line.includes('"cwd"')) return;
    let d;
    try { d = JSON.parse(line); } catch { return; }
    const at = Date.parse(d.timestamp);
    if (!(at >= startedAt)) return;
    if (typeof d.cwd === 'string' && path.isAbsolute(d.cwd)) cwds.add(d.cwd);
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
const blank = () => ({ added: 0, removed: 0, tokens: 0, commits: 0 });

/** One profile's World, kept in `file`. Nothing is written until open(). `run` is the server's execFile wrapper and
 *  `gitPlace` its folder → git checkout lookup. */
export function createWorld({ file, configDir, gitPlace, run, now = Date.now }) {
  let st = null, memo = null;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, file);
    memo = null;
  }

  /** Every transcript of the profile: sessions, and their subagents. */
  function transcripts() {
    const out = [], root = path.join(configDir, 'projects');
    const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
    for (const p of list(root)) {
      if (!p.isDirectory()) continue;
      for (const e of list(path.join(root, p.name))) {
        const f = path.join(root, p.name, e.name);
        if (e.isFile() && e.name.endsWith('.jsonl')) out.push(f);
        else if (e.isDirectory()) for (const s of list(path.join(f, 'subagents'))) if (s.isFile() && s.name.endsWith('.jsonl')) out.push(path.join(f, 'subagents', s.name));
      }
    }
    return out;
  }

  async function scanTokens() {
    let changed = false, read = 0;
    const repos = new Set(st.repos), seenCwds = new Map();
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
      for (const cwd of r.cwds) {
        if (!seenCwds.has(cwd)) seenCwds.set(cwd, gitPlace(cwd)?.repo ?? null);
        const repo = seenCwds.get(cwd);
        if (repo) repos.add(repo);
      }
    }
    st.repos = [...repos];
    return changed;
  }

  async function scanCommits() {
    const noEmail = [];
    for (const repo of st.repos) {
      if (!fs.existsSync(repo)) continue;
      const email = (await run('git', ['-C', repo, 'config', 'user.email'], { timeout: 10_000 })).stdout.trim();
      if (!email) { noEmail.push(repo); continue; }
      const since = Math.floor(st.startedAt / 1000);
      const r = await run('git', ['-C', repo, 'log', '--all', '--no-merges', `--since=${since}`, LOG_FORMAT, '--numstat'], { timeout: 10_000 });
      if (r.err) continue; // keep what it counted before
      // Once counted, a commit stays (a branch deleted after a squash merge takes its commits away); a rebased or
      // amended one has the same key and its newest lines replace the old.
      for (const c of parseLog(r.stdout, email, since)) st.commits[c.key] = { day: c.day, added: c.added, removed: c.removed };
    }
    st.noEmail = noEmail;
  }

  return {
    started: () => Boolean(st),
    open() {
      if (st) return;
      st = { v: 1, startedAt: now(), seed: crypto.randomInt(2 ** 31), files: {}, tokens: {}, commits: {}, repos: [], noEmail: [], purchases: [] };
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
      for (const c of Object.values(st.commits)) {
        const x = (days[c.day] ??= blank());
        x.added += c.added; x.removed += c.removed; x.commits++;
      }
      const earned = Object.values(days).reduce((sum, x) => sum + dayCredit(x), 0);
      const spent = st.purchases.reduce((sum, p) => sum + (p.price ?? 0), 0), t = days[today] ?? blank();
      const summary = { started: true, startedAt: st.startedAt, seed: st.seed, earned, spent, balance: earned - spent, grown: grown(earned),
        today: { day: today, commits: t.commits, added: t.added, removed: t.removed, multiplier: multiplier(t.added, t.removed), tokens: t.tokens, credit: dayCredit(t) },
        noEmail: st.noEmail };
      memo = { today, summary };
      return summary;
    },
  };
}
