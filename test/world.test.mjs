// World: what earns credit, and how the world remembers it. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { dayKey, multiplier, dayCredit, dayFill, terraform, STAGES, FULL_DAY, commitKey, countsFile, readTokens, parseLog, createWorld } from '../world.mjs';

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

test('a full day is 300 credit; more work does not rush the world', () => {
  assert.equal(FULL_DAY, 300);
  assert.equal(dayFill({ tokens: 3_000_000 }), 1); // about an hour of one agent working
  assert.equal(dayFill({ tokens: 30_000_000 }), 1);
  assert.equal(dayFill({ tokens: 1_500_000 }), 0.5);
  assert.equal(dayFill({ added: 600 }), 0.2); // ideas without commits count through tokens, commits through lines
  assert.equal(dayFill({}), 0); // a day you only looked counts nothing
  assert.equal(dayFill(undefined), 0);
});

test('terraforming adds up the days worked and names the stage', () => {
  const days = { '2026-10-19': { tokens: 9e6 }, '2026-10-20': { tokens: 1.5e6 }, '2026-10-21': { added: 600 } };
  assert.deepEqual(terraform(days, '2026-10-21'), { days: 1.7, today: 0.2, stage: 'Oceans', next: { name: 'Continents', at: 3 } });
  assert.deepEqual(terraform({}, '2026-10-21'), { days: 0, today: 0, stage: 'Bare rock', next: { name: 'Clouds', at: 0.15 } });
});

test('twenty full days take a bare rock to terraformed', () => {
  assert.deepEqual(STAGES.map(([at]) => at), [0, 0.15, 1, 3, 5, 8, 12, 16, 20]);
  const full = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-11-${String(i + 1).padStart(2, '0')}`, { tokens: 3e6 }]));
  assert.equal(terraform(full(19), '2026-11-19').stage, 'Cities');
  assert.deepEqual(terraform(full(20), '2026-11-20'), { days: 20, today: 1, stage: 'Terraformed', next: null });
  assert.equal(terraform(full(25), '2026-11-25').stage, 'Terraformed');
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
  assert.deepEqual(readTokens(file, undefined, START).dirs.sort(), ['/work/a', '/work/b']);
});

test('the folders of files it edited are reported too', () => {
  const file = path.join(tmp(), 's.jsonl');
  const edit = { type: 'assistant', timestamp: new Date(START + 1000).toISOString(), cwd: '/work/a',
    message: { id: 'm1', usage: USAGE, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/other/repo/src/x.js' } }] } };
  fs.writeFileSync(file, JSON.stringify(edit) + '\n');
  assert.deepEqual(readTokens(file, undefined, START).dirs.sort(), ['/other/repo/src', '/work/a']);
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
  const world = createWorld({ file, configDirs: [configDir], run, gitPlace: (d) => (d.startsWith(cwd) ? { repo: cwd } : null), now: () => T0 });
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
  const closed = createWorld({ file, configDirs: [configDir], run, gitPlace: () => null, now: () => T0 });
  assert.deepEqual(closed.summary(), { started: false });
  assert.equal(fs.existsSync(file), false);
  const r = repo();
  commit(r, 'a.txt', 30, 10);
  const { world, file: f2, configDir: c2 } = worldOver(r);
  await world.scan({ git: true });
  const before = world.summary();
  assert.ok(before.earned > 0);
  assert.equal(typeof before.seed, "number"); // the view draws the same world from it every time
  const again = createWorld({ file: f2, configDirs: [c2], run, gitPlace: () => null, now: () => T0 });
  assert.equal(again.started(), true);
  assert.deepEqual(again.summary(), before);
});

test('the summary carries the terraforming clock, today filling as work comes in', async () => {
  const configDir = tmp(), file = path.join(tmp(), 'w.json');
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  const world = createWorld({ file, configDirs: [configDir], run, gitPlace: () => null, now: () => T0 });
  world.open();
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'), reply('m1', T0 + 5000, { output_tokens: 1_500_000 }));
  await world.scan({ git: false });
  assert.deepEqual(world.summary().terraform, { days: 0.5, today: 0.5, stage: 'Clouds', next: { name: 'Oceans', at: 1 } });
  assert.equal('grown' in world.summary(), false);
});

test('one repository reached under two spellings of its path counts once', async () => {
  const r = repo(), upper = r.replace(/world-/, 'WORLD-'); // the Mac's disk ignores case: the same folder
  assert.ok(fs.existsSync(upper) && upper !== r);
  commit(r, 'a.txt', 3, 10);
  const configDir = tmp(), file = path.join(tmp(), 'w.json');
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  const gitPlace = (d) => (d.toLowerCase().startsWith(r.toLowerCase()) ? { repo: d.slice(0, r.length) } : null); // git echoes the spelling it was given
  const world = createWorld({ file, configDirs: [configDir], run, gitPlace, now: () => T0 });
  world.open();
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'), reply('m1', T0 + 5000, { output_tokens: 1 }, r) + reply('m2', T0 + 6000, { output_tokens: 1 }, upper));
  await world.scan({ git: true });
  assert.equal(world.summary().today.added, 3);
});

test('a world that counted one repository twice is mended when it loads', () => {
  const r = repo(), upper = r.replace(/world-/, 'WORLD-'), file = path.join(tmp(), 'w.json'), day = dayKey(T0);
  const twice = { [day]: { added: 150, removed: 41, commits: 2 } };
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 1, files: {}, tokens: {}, repos: [r, upper], noEmail: [], gitFailed: [],
    purchases: [], lines: { [r]: twice, [upper]: { [day]: { added: 120, removed: 41, commits: 2 } } } }));
  const world = createWorld({ file, configDirs: [], run, gitPlace: () => null, now: () => T0 });
  assert.equal(world.summary().today.added, 150);
  assert.equal(world.summary().today.commits, 2);
});

test('every profile on the Mac feeds one World', async () => {
  const a = tmp(), b = tmp(), file = path.join(tmp(), 'world', 'world.json');
  for (const [dir, n] of [[a, 100], [b, 50]]) {
    fs.mkdirSync(path.join(dir, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', 'p', 's.jsonl'), reply(`m${n}`, T0 + 5000, { output_tokens: n }));
  }
  const world = createWorld({ file, configDirs: () => [a, b], run, gitPlace: () => null, now: () => T0 });
  world.open();
  for (const dir of [a, b]) fs.utimesSync(path.join(dir, 'projects', 'p', 's.jsonl'), new Date(), new Date());
  await world.scan({ git: false });
  assert.equal(world.summary().today.tokens, 150);
});

test('a repository found through an edited file counts', async () => {
  const r = repo();
  commit(r, 'a.txt', 3, 10);
  const { world, configDir } = worldOver('/not/a/repo');
  const edit = { type: 'assistant', timestamp: new Date(T0 + 6000).toISOString(), cwd: '/not/a/repo',
    message: { id: 'e1', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(r, 'a.txt') } }] } };
  fs.appendFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'), JSON.stringify(edit) + '\n');
  const w2 = createWorld({ file: path.join(tmp(), 'w.json'), configDirs: [configDir], run, gitPlace: (d) => (d.startsWith(r) ? { repo: r } : null), now: () => T0 });
  w2.open();
  await w2.scan({ git: true });
  assert.equal(w2.summary().today.added, 3);
  void world;
});

test('stashed work does not count', async () => {
  const r = repo();
  commit(r, 'a.txt', 3, 10);
  fs.appendFileSync(path.join(r, 'a.txt'), 'wip 1\nwip 2\n');
  fs.writeFileSync(path.join(r, 'new.txt'), Array.from({ length: 50 }, (_, i) => `n${i}`).join('\n') + '\n');
  git(r, ['stash', '-q', '-u'], 20);
  const { world } = worldOver(r);
  await world.scan({ git: true });
  assert.deepEqual([world.summary().today.commits, world.summary().today.added], [1, 3]);
});

test('an amend with a new message does not add up', async () => {
  const r = repo();
  commit(r, 'a.txt', 3, 10);
  const { world } = worldOver(r);
  await world.scan({ git: true });
  fs.appendFileSync(path.join(r, 'a.txt'), 'one more\n');
  git(r, ['add', '-A'], 90);
  git(r, ['commit', '-q', '--amend', '-m', 'a better message'], 90, { GIT_AUTHOR_DATE: at(10) });
  await world.scan({ git: true });
  assert.deepEqual([world.summary().today.commits, world.summary().today.added], [1, 4]);
});

test('when both versions of a commit are reachable, the newest counts', async () => {
  const r = repo();
  commit(r, 'a.txt', 1, 10);
  git(r, ['branch', 'backup'], 20);
  fs.appendFileSync(path.join(r, 'a.txt'), Array.from({ length: 9 }, (_, i) => `more ${i}`).join('\n') + '\n');
  git(r, ['add', '-A'], 90);
  git(r, ['commit', '-q', '--amend', '--no-edit'], 90, { GIT_AUTHOR_DATE: at(10) });
  const { world } = worldOver(r);
  await world.scan({ git: true });
  assert.deepEqual([world.summary().today.commits, world.summary().today.added], [1, 10]);
});

test('git filters to my commits, leaves the stash out, and reads a bounded window', async () => {
  const r = repo(), calls = [];
  const spy = (cmd, args, opts) => { calls.push(args); return run(cmd, args, opts); };
  const configDir = tmp(), file = path.join(tmp(), 'w.json');
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  const NOW = T0 + 90 * 86_400_000, opened = T0; // World opened 90 days before this scan
  const world = createWorld({ file, configDirs: [configDir], run: spy, gitPlace: () => ({ repo: r }), now: () => opened });
  world.open();
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'), reply('m1', T0 + 5000, { output_tokens: 1 }, r));
  const later = createWorld({ file, configDirs: [configDir], run: spy, gitPlace: () => ({ repo: r }), now: () => NOW });
  await later.scan({ git: true });
  const log = calls.find((a) => a.includes('log'));
  assert.ok(log.includes('--author=<me@example.com>') && log.includes('--committer=<me@example.com>'));
  assert.ok(log.indexOf('--exclude=refs/stash') < log.indexOf('--all'));
  const since = Number(log.find((a) => a.startsWith('--since=')).slice(8));
  assert.ok(since >= Math.floor(NOW / 1000) - 31 * 86_400);
});

test('a repository whose log fails is listed', async () => {
  const r = repo();
  commit(r, 'a.txt', 3, 10);
  const failing = (cmd, args, opts) => (args.includes('log') ? Promise.resolve({ err: new Error('timed out'), stdout: '', stderr: '' }) : run(cmd, args, opts));
  const configDir = tmp();
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  const world = createWorld({ file: path.join(tmp(), 'w.json'), configDirs: [configDir], run: failing, gitPlace: () => ({ repo: r }), now: () => T0 });
  world.open();
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'), reply('m1', T0 + 5000, { output_tokens: 1 }, r));
  await world.scan({ git: true });
  assert.deepEqual(world.summary().gitFailed, [r]);
});

test('a broken world file is set aside, not fatal', () => {
  const dir = tmp(), file = path.join(dir, 'world.json');
  fs.writeFileSync(file, '{}');
  const world = createWorld({ file, configDirs: [tmp()], run, gitPlace: () => null, now: () => T0 });
  assert.deepEqual(world.summary(), { started: false });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('world.json.bad-')).length, 1);
});
