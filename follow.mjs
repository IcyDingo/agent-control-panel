// Following one transcript as Claude Code appends to it, so the open session's Chat shows each line as it lands.
//
// A transcript only ever grows by whole JSON lines, but it runs to hundreds of megabytes, so a change is never answered
// by reading the file again: only the bytes after the last read, `[offset, size)`, are read, and only whole lines are
// parsed. A line still being written stays in a carry buffer until its newline arrives. `fs.watch` says when to look;
// a slow `stat` poll backs it up, because a watch can fire early, miss a change, or die with the file. A file that
// shrank or was replaced (a new inode) is read again from the start, after `onReset` tells the reader to drop what it has.

import fs from 'node:fs';
import { itemOf } from './history.mjs';

const NL = 0x0a;

/** Follow `file` from its current end: whole appended lines → `onItems(items)`, one call per read that found any. */
export function createFollow(file, { onItems, onReset, pollMs = 1000 }) {
  let offset = 0, ino = null, carry = Buffer.alloc(0), watcher = null, timer = null, stopped = false, busy = false, again = false;

  function watch() {
    watcher?.close();
    watcher = null;
    if (stopped) return;
    try {
      watcher = fs.watch(file, { persistent: false }, () => { look(); });
      watcher.on('error', () => { watcher?.close(); watcher = null; }); // the file went away: the poll carries on alone
    } catch { watcher = null; }
  }

  /** `check`, from a watch or the poll: a read that fails is logged, and the next look tries again. */
  function look() { check().catch((err) => console.error('follow:', err)); }

  /** Read what was appended since the last read; a read in progress makes this one more read after it. */
  async function check() {
    if (stopped) return;
    if (busy) { again = true; return; }
    busy = true;
    try { do { again = false; await step(); } while (again && !stopped); } finally { busy = false; }
  }

  async function step() {
    let st;
    try { st = await fs.promises.stat(file); } catch { return; } // gone for now: look again on the next poll
    if (stopped) return;
    if (st.ino !== ino || st.size < offset) {
      const moved = st.ino !== ino;
      ino = st.ino; offset = 0; carry = Buffer.alloc(0);
      onReset();
      if (moved) watch(); // the old watch is on the file that was replaced
    }
    if (st.size <= offset) return;
    const fresh = await readRange(offset, st.size);
    if (stopped || !fresh.length) return;
    const base = offset - carry.length, buf = carry.length ? Buffer.concat([carry, fresh]) : fresh, items = [];
    offset += fresh.length;
    let start = 0;
    for (let nl = buf.indexOf(NL); nl !== -1; start = nl + 1, nl = buf.indexOf(NL, start)) {
      const item = itemOf(buf.toString('utf8', start, nl), base + start);
      if (item) items.push(item);
    }
    carry = buf.subarray(start);
    if (items.length) onItems(items);
  }

  /** The bytes of `[from, to)`, or fewer if the file shrank meanwhile. */
  async function readRange(from, to) {
    let fh;
    try { fh = await fs.promises.open(file, 'r'); } catch { return Buffer.alloc(0); }
    try {
      const buf = Buffer.alloc(to - from);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, from + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    } catch { return Buffer.alloc(0); } finally { await fh.close(); }
  }

  return {
    /** Stat the file, start at its end, and begin watching it. */
    async start() {
      const st = await fs.promises.stat(file);
      ino = st.ino; offset = st.size;
      watch();
      timer = setInterval(look, pollMs);
      timer.unref();
    },
    /** Stop watching; nothing is read or called after this. */
    stop() { stopped = true; watcher?.close(); watcher = null; clearInterval(timer); },
    /** The byte offset read up to, the carry included. */
    offset: () => offset,
  };
}
