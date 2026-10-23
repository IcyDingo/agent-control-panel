// World: what earns credit, and how the world remembers it. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { dayKey, multiplier, dayWork, dayCredit, dayXp, oldDayCredit, oldDayXp, homeLevel, levelOf, homeReach, HOME_FEATURES, COLONY_FEATURES, colonyStage, LEVELS, FULL_DAY, commitKey, countsFile, readTokens, parseLog, createWorld } from '../world.mjs';

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

test('old days keep the old formula', () => {
  assert.equal(oldDayCredit({ added: 11000, removed: 0, tokens: 1_500_000 }), 1250);
  assert.equal(oldDayCredit({ added: 50, removed: 300, tokens: 0 }), Math.round(5 * 3.6));
  assert.equal(oldDayCredit({ added: 300, removed: 0, tokens: 1_000_000 }), 130);
  assert.equal(oldDayXp({ added: 3000, tokens: 0 }), 100); // 300 credit, a full day under the old rules
});

test("the new day credit follows the spec's table", () => {
  assert.equal(dayWork({ added: 20, removed: 10, commits: 1, slots: 36 }), 230);
  assert.equal(dayWork({ slots: 288 }), dayWork({ slots: 120 }));
  assert.equal(dayWork({}), 0);
  assert.equal(dayCredit({ slots: 3 }), 25); // 15 minutes
  assert.equal(dayCredit({ added: 20, removed: 10, commits: 1, slots: 36 }), 162); // 3 hours, one 30-line fix
  assert.equal(dayCredit({ slots: 48 }), 165); // 4 hours, nothing committed
  assert.equal(dayCredit({ added: 100, removed: 50, commits: 3, slots: 96 }), 253); // a typical full day
  assert.equal(dayCredit({ added: 2000, removed: 1000, commits: 10, slots: 96 }), 404);
  assert.equal(dayCredit({ slots: 288 }), dayCredit({ slots: 120 }), 'past 10 hours, time stops counting');
  assert.equal(dayCredit({ tokens: 5_000_000 }), 0, 'tokens alone earn nothing');
  assert.equal(dayCredit({}), 0);
  assert.equal(dayXp({ added: 100, removed: 50, commits: 3, slots: 96 }), 84);
  assert.equal(dayXp(undefined), 0);
});

test('day keys are calendar days', () => assert.equal(dayKey(Date.UTC(2026, 9, 21, 23, 59)), '2026-10-21'));

test('a full day is 100 XP; more work earns more, 50 per doubling, with no daily limit', () => {
  assert.equal(FULL_DAY, 300); // credit: about an hour of one agent working
  assert.equal(oldDayXp({ tokens: 3_000_000 }), 100);
  assert.equal(oldDayXp({ tokens: 6_000_000 }), 150);
  assert.equal(oldDayXp({ tokens: 12_000_000 }), 200);
  assert.equal(oldDayXp({ tokens: 24_000_000 }), 250);
  assert.equal(oldDayXp({ tokens: 48_000_000 }), 300);
  assert.equal(oldDayXp({ tokens: 500_000_000 }), 469); // a runaway loop: a hundred and sixty times the work, not even five days' XP
  assert.equal(oldDayXp({ tokens: 1_500_000 }), 50);
  assert.equal(oldDayXp({ added: 600 }), 20); // ideas without commits count through tokens, commits through lines
  assert.equal(oldDayXp({}), 0); // a day you only looked counts nothing
  assert.equal(oldDayXp(undefined), 0);
});

test("Home's level adds up the XP of the days worked", () => {
  const days = { '2026-10-19': { xp: 179 }, '2026-10-20': { xp: 50 }, '2026-10-21': { xp: 20 } }; // stamped, as the store gives them
  assert.deepEqual(homeLevel(days, '2026-10-21'), { xp: 249, today: 20, level: 3, stage: 'Oceans', at: 100, next: { level: 4, name: 'Continents', at: 300 } }); // 179 + 50 + 20
  assert.deepEqual(homeLevel({}, '2026-10-21'), { xp: 0, today: 0, level: 1, stage: 'Bare rock', at: 0, next: { level: 2, name: 'Clouds', at: 15 } });
});

test('level 9 is terraformed after twenty full days, and the levels go on for the productive', () => {
  assert.deepEqual(LEVELS.map(([at]) => at), [0, 15, 100, 300, 500, 800, 1200, 1600, 2000, 2600, 3300, 4000]);
  const days = (n, xp = 100) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-11-${String(i + 1).padStart(2, '0')}`, { xp }]));
  assert.equal(homeLevel(days(19), '2026-11-19').stage, 'Cities');
  assert.deepEqual(homeLevel(days(20), '2026-11-20'), { xp: 2000, today: 100, level: 9, stage: 'Terraformed', at: 2000, next: { level: 10, name: 'Orbital ring', at: 2600 } });
  assert.equal(homeLevel(days(10, 200), '2026-11-10').level, 9); // twice the XP a day: there in ten days
  assert.deepEqual(homeLevel(days(14, 300), '2026-11-14'), { xp: 4200, today: 300, level: 12, stage: 'Twin moons', at: 4000, next: { level: 13, name: HOME_FEATURES[0], at: 5000 } });
});

test('levels past Twin moons come every 1,000 XP', () => {
  assert.deepEqual([levelOf(3999).level, levelOf(4000).level, levelOf(4999).level, levelOf(5000).level], [11, 12, 12, 13]);
  assert.equal(levelOf(5000).stage, HOME_FEATURES[0]);
  assert.equal(levelOf(4000).next.at, 5000, 'the ladder never ends');
  assert.equal(levelOf(4000 + 1000 * (HOME_FEATURES.length + 1)).stage, `${HOME_FEATURES[0]} II`);
  assert.ok(HOME_FEATURES.length >= 12);
  assert.ok(homeReach(10_000) > homeReach(4000) && homeReach(1e9) <= homeReach(4000) + 60);
  assert.equal(homeReach(4000), 166);
});

test('a colony grows through its six stages', () => {
  assert.deepEqual([0, 99, 100, 1999, 2000, 3000].map((x) => colonyStage(x).name),
    ['Landing site', 'Landing site', 'Outpost', 'Township', 'City', COLONY_FEATURES[0]]);
  assert.deepEqual([0, 100, 300, 700, 1300, 2000, 2999, 3000, 4000].map((x) => colonyStage(x).stage), [1, 2, 3, 4, 5, 6, 6, 7, 8]);
  assert.equal(colonyStage(2000 + 1000 * (COLONY_FEATURES.length + 1)).name, `${COLONY_FEATURES[0]} II`);
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

test('readTokens marks the slot of each reply', () => {
  const file = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(file, reply('m1', START + 60_000, USAGE) + reply('m2', START + 7 * 60_000, USAGE) + reply('m3', START + 9 * 60_000, USAGE)
    + reply('m3', START + 20 * 60_000, USAGE)); // m3 again: a reply already counted marks nothing
  assert.deepEqual(readTokens(file, undefined, START).slots, { '2026-10-21': [108, 109] }); // 09:01, then 09:07 and 09:09 in one slot
  const early = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(early, reply('m1', START - 60_000, USAGE));
  assert.deepEqual(readTokens(early, undefined, START).slots, {}, 'nothing from before World started');
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

test("the summary carries Home's level and XP, today's filling as work comes in", async () => {
  const configDir = tmp(), file = path.join(tmp(), 'w.json');
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  const world = createWorld({ file, configDirs: [configDir], run, gitPlace: () => null, now: () => START });
  world.open();
  // Seven replies five minutes apart: 35 minutes of active time, the day's only work (the tokens earn nothing).
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'),
    Array.from({ length: 7 }, (_, i) => reply(`m${i}`, START + 5000 + i * 300_000, { output_tokens: 1_500_000 })).join(''));
  await world.scan({ git: false });
  assert.deepEqual(world.summary().home, { xp: 17, today: 17, level: 2, stage: 'Clouds', at: 15, next: { level: 3, name: 'Oceans', at: 100 } });
  assert.equal('terraform' in world.summary(), false);
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

test('without Apple\'s Command Line Tools no git is run, so a background job never gets the install dialog', async () => {
  const r = repo(), calls = [];
  const spy = (cmd, args, opts) => { calls.push([cmd, ...args]); return cmd === 'xcode-select' ? Promise.resolve({ err: new Error('exit 2'), stdout: '', stderr: 'xcode-select: error: unable to get active developer directory' }) : run(cmd, args, opts); };
  const configDir = tmp();
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  const world = createWorld({ file: path.join(tmp(), 'w.json'), configDirs: [configDir], run: spy, gitPlace: () => ({ repo: r }), now: () => T0 });
  world.open();
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'), reply('m1', T0 + 5000, { output_tokens: 1 }, r));
  await world.scan({ git: true });
  assert.deepEqual(calls.filter((c) => c[0] === 'git'), []);
  assert.equal(world.summary().toolsMissing, true);
  assert.deepEqual(world.summary().gitFailed, []);
});

test('a broken world file is set aside, not fatal', () => {
  const dir = tmp(), file = path.join(dir, 'world.json');
  fs.writeFileSync(file, '{}');
  const world = createWorld({ file, configDirs: [tmp()], run, gitPlace: () => null, now: () => T0 });
  assert.deepEqual(world.summary(), { started: false });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('world.json.bad-')).length, 1);
});

// ---------------------------------------------------------------- switching to the new rules
const DAY = 86_400_000;
const saved = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** A world.json as a World from before the switch kept it: no newFrom, no active time. */
function fromBefore({ tokens = {}, lines = {}, purchases = [] } = {}) {
  const file = path.join(tmp(), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: START - 3 * DAY, seed: 7, files: {}, tokens, lines, repos: [], noEmail: [], gitFailed: [], purchases }));
  return file;
}
const load = (file, at) => createWorld({ file, configDirs: [], run, gitPlace: () => null, now: () => at });

test('a World from before keeps its balance', async () => {
  const work = { '2026-10-18': { tokens: 30e6 }, '2026-10-19': { added: 400, removed: 600, commits: 3 }, '2026-10-20': { tokens: 15e6 },
    '2026-10-21': { added: 50, removed: 0, commits: 1, tokens: 1e6 } }; // the last is the day it loads
  const lines = { '/r': {} }, tokens = {};
  for (const [d, x] of Object.entries(work)) {
    if (x.tokens) tokens[d] = x.tokens;
    if (x.added !== undefined) lines['/r'][d] = { added: x.added, removed: x.removed, commits: x.commits };
  }
  const push = { kind: 'frontier', at: START - DAY, price: 4000, earnedAt: 0, ang: 0 };
  const file = fromBefore({ tokens, lines, purchases: [push] });
  const earned = Object.values(work).reduce((s, x) => s + oldDayCredit(x), 0), xp = Object.values(work).reduce((s, x) => s + oldDayXp(x), 0);
  assert.ok(earned > 4000);
  const world = load(file, START);
  let s = world.summary();
  assert.deepEqual([s.earned, s.spent, s.balance, s.home.xp], [earned, 4000, earned - 4000, xp]);
  assert.equal(saved(file).newFrom, '2026-10-22', 'the day after it was loaded');
  await world.scan({ git: false });
  s = load(file, START + DAY).summary();
  assert.deepEqual([s.earned, s.balance, s.home.xp], [earned, earned - 4000, xp], 'and the next day, after a scan and a restart');
  assert.equal(saved(file).newFrom, '2026-10-22', 'set once');
});

test('the switch day counts the old way until midnight', async () => {
  const work = { added: 300, removed: 100, commits: 2 }, tokens = 2e6;
  const file = fromBefore({ tokens: { '2026-10-21': tokens }, lines: { '/r': { '2026-10-21': work } } });
  load(file, START).summary(); // loaded: the new rules start tomorrow
  const st = saved(file);
  st.active = { '2026-10-21': [108, 109, 110] }; // active time on the load day earns nothing
  fs.writeFileSync(file, JSON.stringify(st));
  const today = load(file, START + 3600_000);
  await today.scan({ git: false });
  const before = today.summary();
  assert.equal(before.today.credit, oldDayCredit({ ...work, tokens }));
  assert.equal(before.earned, oldDayCredit({ ...work, tokens }));
  const peak = saved(file).peak;
  assert.equal(peak, before.earned);
  // The same work the next day, with the active time that came with it.
  const next = saved(file);
  next.tokens['2026-10-22'] = tokens;
  next.lines['/r']['2026-10-22'] = work;
  next.active['2026-10-22'] = [108, 109, 110];
  fs.writeFileSync(file, JSON.stringify(next));
  const tomorrow = load(file, START + DAY);
  await tomorrow.scan({ git: false });
  const after = tomorrow.summary();
  assert.equal(after.today.credit, dayCredit({ ...work, slots: 3 }));
  assert.notEqual(after.today.credit, oldDayCredit({ ...work, tokens }), 'the two rules differ on this work');
  assert.equal(after.earned, before.earned + dayCredit({ ...work, slots: 3 }), 'the switch day kept its old credit');
  assert.equal(after.home.xp, oldDayXp({ ...work, tokens }) + dayXp({ ...work, slots: 3 }));
  assert.ok(saved(file).peak >= peak, 'peak never goes down');
});

test('today shows active minutes and no multiplier', async () => {
  const configDir = tmp(), file = path.join(tmp(), 'w.json');
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  const world = createWorld({ file, configDirs: [configDir], run, gitPlace: () => null, now: () => START });
  world.open();
  assert.equal(saved(file).newFrom, '2026-10-21', 'a World opened now counts by the new rules from its first day');
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'),
    [1, 2, 3, 8].map((m, i) => reply(`m${i}`, START + m * 60_000, { output_tokens: 1000 })).join('')); // slots 108, 108, 108, 109
  await world.scan({ git: false });
  assert.deepEqual(world.summary().today, { day: '2026-10-21', commits: 0, added: 0, removed: 0, tokens: 4000, active: 10, credit: dayCredit({ slots: 2 }) });
  assert.deepEqual(saved(file).active, { '2026-10-21': [108, 109] });
  const st = saved(file);
  st.active['2026-10-21'] = Array.from({ length: 200 }, (_, i) => i); // more than ten hours
  fs.writeFileSync(file, JSON.stringify(st));
  const t = load(file, START).summary().today;
  assert.deepEqual([t.active, t.credit], [600, dayCredit({ slots: 120 })], 'ten hours at most');
});
