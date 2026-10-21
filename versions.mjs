// Sessions running a Claude Code version that has been deleted under them.
//
// Claude Code's updater deletes old versions while sessions still run them. macOS then can't name the program behind
// the session when it checks a privacy-protected folder (~/Documents, ~/Desktop, cloud folders), so tccd fails to
// build its attribution chain and the sandbox refuses the session and everything it starts, at the first re-check.
// The cure is a restart on the installed version, so the panel says which sessions need one before that happens.

import fs from 'node:fs';
import path from 'node:path';

/** `ps -axo pid=,ppid=,ucomm=` → pid → { ppid, name }. */
export function parsePs(text) {
  const procs = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), name: m[3] });
  }
  return procs;
}

/** `lsof -d txt -Fpin` → pid → { path, inode } of its program: the first text file lsof lists for it. */
export function parseLsof(text) {
  const programs = new Map();
  let pid = null, inode = null;
  for (const line of String(text).split('\n')) {
    const k = line[0], v = line.slice(1);
    if (k === 'p') { pid = Number(v); inode = null; }
    else if (k === 'f') inode = null;
    else if (k === 'i') inode = Number(v);
    else if (k === 'n' && pid != null && !programs.has(pid)) programs.set(pid, { path: v, inode });
  }
  return programs;
}

/** The version in a program's path: its file name, or a folder it sits in. */
export function versionOf(file) {
  return String(file).split('/').reverse().find((p) => /^\d+\.\d+\.\d+$/.test(p)) ?? null;
}

const inodeOnDisk = (file) => { try { return fs.statSync(file).ino; } catch { return null; } };

/** The first process from `pid` up through the ones it was started from whose program file is gone (or is another
 *  file now): { pid, self, name, path, version }, or null. A process lsof can't see is skipped, not suspected. */
export function removedUnder(pid, { procs, programs, inodeOf = inodeOnDisk }) {
  const seen = new Set();
  for (let cur = pid; cur > 1 && procs.has(cur) && !seen.has(cur) && seen.size < 16; cur = procs.get(cur).ppid) {
    seen.add(cur);
    const prog = programs.get(cur);
    if (!prog?.path) continue;
    if (inodeOf(prog.path) === prog.inode) continue;
    return { pid: cur, self: cur === pid, name: procs.get(cur).name, path: prog.path, version: versionOf(prog.path) ?? path.basename(prog.path) };
  }
  return null;
}

/** pid → removedUnder() for each running session's pid, from one ps and one lsof. Empty when either fails: a missed
 *  warning is better than a false one. */
export async function findRemoved(pids, { run, inodeOf = inodeOnDisk }) {
  const found = new Map();
  const live = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 1);
  if (!live.length) return found;
  try {
    const procs = parsePs((await run('ps', ['-axo', 'pid=,ppid=,ucomm='])).stdout);
    const check = new Set();
    for (const pid of live) for (let cur = pid; cur > 1 && procs.has(cur) && !check.has(cur); cur = procs.get(cur).ppid) check.add(cur);
    if (!check.size) return found;
    // lsof exits 1 when a process has gone between the two calls: what it printed still holds.
    const programs = parseLsof((await run('lsof', ['-a', '-p', [...check].join(','), '-d', 'txt', '-Fpin'])).stdout);
    for (const pid of live) {
      const r = removedUnder(pid, { procs, programs, inodeOf });
      if (r) found.set(pid, r);
    }
  } catch { found.clear(); }
  return found;
}
