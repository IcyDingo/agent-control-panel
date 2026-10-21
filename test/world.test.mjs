// World: what earns credit, and how the world remembers it. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dayKey, multiplier, dayCredit, grown, commitKey, countsFile, readTokens } from '../world.mjs';

const START = Date.UTC(2026, 9, 21, 9, 0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'world-'));
/** One transcript line for an assistant reply. */
const reply = (id, at, usage, cwd = '/tmp') =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), cwd, message: { id, role: 'assistant', usage } }) + '\n';
const USAGE = { input_tokens: 2, output_tokens: 57, cache_creation_input_tokens: 100, cache_read_input_tokens: 9999 };

test('multiplier rewards removing', () => {
  assert.equal(multiplier(0, 0), 1);
  assert.equal(multiplier(1000, 0), 1);
  assert.equal(multiplier(500, 500), 2.5);
  assert.equal(multiplier(0, 300), 4);
});

test('a day of work earns credit', () => {
  assert.equal(dayCredit({ added: 11000, removed: 0, tokens: 1_500_000 }), 1250);
  assert.equal(dayCredit({ added: 50, removed: 300, tokens: 0 }), Math.round(5 * 3.6));
});

test('day keys are calendar days', () => assert.equal(dayKey(Date.UTC(2026, 9, 21, 23, 59)), '2026-10-21'));

test('growth starts at nothing and never ends', () => {
  assert.equal(grown(0), 0);
  assert.ok(grown(30000) > 0.6 && grown(30000) < 0.64);
  assert.ok(grown(300_000) < 1); // about a year of work
});

test('a rebased or amended commit keeps its key', () => {
  assert.equal(commitKey(1792584000, 'fix: x'), commitKey(1792584000, 'fix: x'));
  assert.notEqual(commitKey(1792584000, 'fix: x'), commitKey(1792584001, 'fix: x'));
});

test('lockfiles do not count', () => {
  assert.equal(countsFile('a/package-lock.json'), false);
  assert.equal(countsFile('go.sum'), false);
  assert.equal(countsFile('src/a.js'), true);
});

test('one reply split over several entries counts once', () => {
  const file = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(file, reply('m1', START + 1000, USAGE) + reply('m1', START + 1001, USAGE));
  assert.deepEqual(readTokens(file, undefined, START).tokens, { '2026-10-21': 159 });
});

test('only new lines are read the second time', () => {
  const file = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(file, reply('m1', START + 1000, USAGE));
  const first = readTokens(file, undefined, START);
  fs.appendFileSync(file, reply('m1', START + 1500, USAGE) + reply('m2', START + 2000, { input_tokens: 4, output_tokens: 6 }));
  assert.deepEqual(readTokens(file, first.state, START).tokens, { '2026-10-21': 10 });
});

test('entries from before World started do not count', () => {
  const file = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(file, reply('m1', START - 1000, USAGE));
  assert.deepEqual(readTokens(file, undefined, START).tokens, {});
});

test('an old file at first open is skipped, not read', () => {
  const file = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(file, reply('m1', START + 1000, USAGE));
  fs.utimesSync(file, new Date(START - 60_000), new Date(START - 60_000));
  const r = readTokens(file, undefined, START);
  assert.deepEqual(r.tokens, {});
  assert.equal(r.state.offset, fs.statSync(file).size);
});

test('a file that shrank is not recounted', () => {
  const file = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(file, reply('m1', START + 1000, USAGE));
  const r = readTokens(file, { offset: 10_000, ids: [] }, START);
  assert.deepEqual(r.tokens, {});
  assert.equal(r.state.offset, fs.statSync(file).size);
});

test('a half-written last line waits', () => {
  const file = path.join(tmp(), 's.jsonl');
  const whole = reply('m1', START + 1000, USAGE);
  fs.writeFileSync(file, whole + reply('m2', START + 2000, USAGE).slice(0, 30));
  const r = readTokens(file, undefined, START);
  assert.equal(r.state.offset, Buffer.byteLength(whole));
  assert.deepEqual(r.tokens, { '2026-10-21': 159 });
});

test('the folders it worked in are reported', () => {
  const file = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(file, reply('m1', START + 1000, USAGE, '/work/a') + reply('m2', START + 2000, USAGE, '/work/a') + reply('m3', START + 3000, USAGE, '/work/b'));
  assert.deepEqual(readTokens(file, undefined, START).cwds.sort(), ['/work/a', '/work/b']);
});

test('a long transcript with non-ASCII text is read to the byte', () => {
  const file = path.join(tmp(), 's.jsonl');
  // Shift the text until the 4 MB read boundary falls inside a multi-byte character.
  let body;
  for (let shift = 0; shift < 4; shift++) {
    const lines = [];
    for (let i = 0; i < 1500; i++) lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date(START + i).toISOString(), note: 'x'.repeat(i ? 0 : shift) + 'ø€'.repeat(700 + (i % 3)), message: { id: `m${i}`, usage: USAGE } }) + '\n');
    body = Buffer.from(lines.join(''));
    if ((body[4 << 20] & 0xc0) === 0x80) break;
  }
  assert.equal(body[4 << 20] & 0xc0, 0x80);
  fs.writeFileSync(file, body);
  const r = readTokens(file, undefined, START);
  assert.equal(r.state.offset, fs.statSync(file).size);
  assert.deepEqual(r.tokens, { '2026-10-21': 1500 * 159 });
});
