// World: what earns credit, and how the world remembers it. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { dayKey, multiplier, dayCredit, grown, commitKey, countsFile, readTokens, parseLog, createWorld } from '../world.mjs';

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

// ---------------------------------------------------------------- commits and the store
// Git runs with no global or system config, so the tests never see this machine's identity.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const T0 = Date.now() - 3600_000; // World opened an hour ago; commits are dated after it
const at = (sec) => `${Math.floor(T0 / 1000) + sec} +0000`;
const git = (repo, args, sec = 10, extra = {}) =>
  execFileSync('git', ['-C', repo, ...args], { env: { ...GIT_ENV, GIT_AUTHOR_DATE: at(sec), GIT_COMMITTER_DATE: at(sec), ...extra }, stdio: 'pipe' }).toString();
const run = (cmd, args, opts = {}) => new Promise((resolve) =>
  execFile(cmd, args, { env: GIT_ENV, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })));
function repo({ email = 'me@example.com' } = {}) {
  const r = fs.realpathSync(tmp());
  git(r, ['init', '-q', '-b', 'main']);
  if (email) { git(r, ['config', 'user.email', email]); git(r, ['config', 'user.name', 'Me']); }
  return r;
}
function commit(r, file, lines, sec, who = null) {
  fs.mkdirSync(path.dirname(path.join(r, file)), { recursive: true });
  fs.appendFileSync(path.join(r, file), Array.from({ length: lines }, (_, i) => `line ${sec} ${i}`).join('\n') + '\n');
  git(r, ['add', '-A'], sec);
  git(r, [...(who ? ['-c', `user.email=${who}`, '-c', 'user.name=Someone'] : []), 'commit', '-q', '-m', `add ${file} at ${sec}`], sec);
}
/** A profile folder whose one transcript worked in `cwd`, and a World over it. */
function worldOver(cwd) {
  const configDir = tmp(), file = path.join(tmp(), 'world', 'default.json');
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  const world = createWorld({ file, configDir, run, gitPlace: (d) => (d.startsWith(cwd) ? { repo: cwd } : null), now: () => T0 });
  world.open();
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'), reply('m1', T0 + 5000, { output_tokens: 10_000 }, cwd));
  return { world, file, configDir };
}

test('only my commits count, merges and lockfiles do not', async () => {
  const r = repo();
  commit(r, 'a.txt', 3, 10);
  commit(r, 'b.txt', 5, 20, 'other@example.com');
  commit(r, 'package-lock.json', 100, 30);
  git(r, ['switch', '-q', '-c', 'side'], 40);
  commit(r, 'c.txt', 2, 50);
  git(r, ['switch', '-q', 'main'], 60);
  git(r, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], 70);
  const { world } = worldOver(r);
  await world.scan({ git: true });
  const t = world.summary().today;
  assert.equal(t.added, 5);
  assert.equal(t.commits, 3); // a.txt, the lockfile commit (its lines don't count) and c.txt
  assert.equal(t.tokens, 10_000);
});

test('a squash merged on GitHub does not count again', () => {
  const text = '\x1eabc\x1f1792584000\x1fme@example.com\x1fnoreply@github.com\x1fA squash (#12)\n\n3\t0\ta.txt\n';
  assert.deepEqual(parseLog(text, 'me@example.com'), []);
  assert.equal(parseLog(text.replace('noreply@github.com', 'ME@example.com'), 'me@example.com').length, 1);
});

test('credit stays after the branch is deleted', async () => {
  const r = repo();
  commit(r, 'a.txt', 1, 10);
  git(r, ['switch', '-q', '-c', 'feat'], 20);
  commit(r, 'b.txt', 4, 30);
  const { world } = worldOver(r);
  await world.scan({ git: true });
  assert.equal(world.summary().today.added, 5);
  git(r, ['switch', '-q', 'main'], 40);
  git(r, ['branch', '-q', '-D', 'feat'], 40);
  git(r, ['reflog', 'expire', '--expire=now', '--all'], 40);
  git(r, ['gc', '-q', '--prune=now'], 40);
  await world.scan({ git: true });
  assert.equal(world.summary().today.added, 5);
});

test('a rebased commit is not counted twice', async () => {
  const r = repo();
  commit(r, 'a.txt', 1, 10);
  const { world } = worldOver(r);
  await world.scan({ git: true });
  fs.appendFileSync(path.join(r, 'a.txt'), 'one more\n');
  git(r, ['add', '-A'], 90);
  git(r, ['commit', '-q', '--amend', '--no-edit'], 90, { GIT_AUTHOR_DATE: at(10) });
  await world.scan({ git: true });
  const t = world.summary().today;
  assert.equal(t.commits, 1);
  assert.equal(t.added, 2);
});

test('a repository without user.email is listed, not counted', async () => {
  const r = repo({ email: null });
  commit(r, 'a.txt', 3, 10, 'me@example.com');
  const { world } = worldOver(r);
  await world.scan({ git: true });
  assert.deepEqual(world.summary().noEmail, [r]);
  assert.equal(world.summary().today.commits, 0);
});

test('nothing is stored until World is opened, and it survives a restart', async () => {
  const configDir = tmp(), file = path.join(tmp(), 'world', 'default.json');
  const closed = createWorld({ file, configDir, run, gitPlace: () => null, now: () => T0 });
  assert.deepEqual(closed.summary(), { started: false });
  assert.equal(fs.existsSync(file), false);
  const r = repo();
  commit(r, 'a.txt', 30, 10);
  const { world, file: f2, configDir: c2 } = worldOver(r);
  await world.scan({ git: true });
  const before = world.summary();
  assert.ok(before.earned > 0);
  const again = createWorld({ file: f2, configDir: c2, run, gitPlace: () => null, now: () => T0 });
  assert.equal(again.started(), true);
  assert.deepEqual(again.summary(), before);
});
