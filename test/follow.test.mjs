// Following a transcript as it grows: appended whole lines become thread items, nothing is read twice. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFollow } from '../follow.mjs';

let n = 0;
const said = (text) => JSON.stringify({ parentUuid: 'x', isSidechain: false,
  message: { model: 'claude-opus-5-5', id: `msg_${n++}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
  type: 'assistant', uuid: `a${n++}`, timestamp: '2026-11-04T09:00:00.000Z' });
const HEADER = JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 's' }) + '\n'; // never talk
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A temp transcript holding `initial`, and a started follow of it that records every onItems and onReset call. */
async function following(t, initial = HEADER) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-follow-')), file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, initial);
  const calls = [], resets = [];
  const f = createFollow(file, { onItems: (items) => calls.push(items), onReset: () => resets.push(calls.length), pollMs: 50 });
  t.after(() => { f.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await f.start();
  return { dir, file, f, calls, resets };
}

test('an appended line is one item with the offset where it began', async (t) => {
  const { file, f, calls } = await following(t);
  assert.equal(f.offset(), Buffer.byteLength(HEADER));
  fs.appendFileSync(file, said('hi') + '\n');
  assert.ok(await until(() => calls.length > 0));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((m) => [m.who, m.text, m.pos]), [['claude', 'hi', Buffer.byteLength(HEADER)]]);
  assert.equal(f.offset(), fs.statSync(file).size);
});

test('a line split across two writes is parsed once, when its newline arrives', async (t) => {
  const { file, f, calls } = await following(t);
  const line = said('half and half'), cut = Math.floor(line.length / 2);
  fs.appendFileSync(file, line.slice(0, cut));
  await wait(200);
  assert.equal(calls.length, 0, 'a line without its newline was parsed');
  assert.equal(f.offset(), fs.statSync(file).size, 'the half line was not read into the carry');
  fs.appendFileSync(file, line.slice(cut) + '\n');
  assert.ok(await until(() => calls.length > 0));
  await wait(150);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((m) => [m.text, m.pos]), [['half and half', Buffer.byteLength(HEADER)]]);
});

test('three lines in one write are one onItems call with three items', async (t) => {
  const { file, calls } = await following(t);
  const lines = [said('one'), said('two'), said('three')], h = Buffer.byteLength(HEADER);
  fs.appendFileSync(file, lines.join('\n') + '\n');
  assert.ok(await until(() => calls.length > 0));
  await wait(150);
  assert.equal(calls.length, 1);
  const pos = (i) => h + lines.slice(0, i).reduce((p, l) => p + Buffer.byteLength(l) + 1, 0);
  assert.deepEqual(calls[0].map((m) => [m.text, m.pos]), [['one', pos(0)], ['two', pos(1)], ['three', pos(2)]]);
});

test('a truncated file resets and reads from the start', async (t) => {
  const { file, calls, resets } = await following(t);
  fs.appendFileSync(file, said('before') + '\n');
  assert.ok(await until(() => calls.length === 1));
  fs.truncateSync(file, 0);
  assert.ok(await until(() => resets.length === 1));
  fs.appendFileSync(file, said('after') + '\n');
  assert.ok(await until(() => calls.length === 2));
  await wait(150);
  assert.equal(resets.length, 1);
  assert.deepEqual(calls[1].map((m) => [m.text, m.pos]), [['after', 0]]);
});

test('a replaced file (new inode) resets', async (t) => {
  const { dir, file, f, calls, resets } = await following(t);
  const other = path.join(dir, 'other.jsonl'), first = said('new file') + '\n';
  fs.writeFileSync(other, first);
  fs.renameSync(other, file);
  assert.ok(await until(() => calls.length === 1));
  assert.deepEqual(resets, [0], 'onReset came before the new file\'s items');
  assert.deepEqual(calls[0].map((m) => [m.text, m.pos]), [['new file', 0]]);
  fs.appendFileSync(file, said('and more') + '\n');
  assert.ok(await until(() => calls.length === 2), 'the new file is not followed');
  assert.deepEqual(calls[1].map((m) => [m.text, m.pos]), [['and more', Buffer.byteLength(first)]]);
  assert.equal(f.offset(), fs.statSync(file).size);
});

test('stop() ends it: a later append is not seen', async (t) => {
  const { file, f, calls, resets } = await following(t);
  f.stop();
  fs.appendFileSync(file, said('unseen') + '\n');
  fs.truncateSync(file, 0);
  await wait(300);
  assert.equal(calls.length, 0);
  assert.equal(resets.length, 0);
  assert.equal(f.offset(), Buffer.byteLength(HEADER));
});
