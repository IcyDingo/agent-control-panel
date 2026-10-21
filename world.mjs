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
