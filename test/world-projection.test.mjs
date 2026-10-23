// What of World may leave this Mac: the shape of the system, never the numbers that paid for it. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, publicProjection, validProjection, PROJECTION_VERSION, LEVELS, HOME_FEATURES, COLONY_FEATURES, levelOf, levelName, colonyStage, colonyStageName } from '../world.mjs';

const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 12, 9, 0), at = (d) => T0 + d * DAY, key = (ms) => new Date(ms).toISOString().slice(0, 10);
// The same fixture as test/world-universe.test.mjs (each World test file carries its own, as the existing ones do).
function seeded({ tokens = {}, lines = {}, purchases = [], now = at(0), extra = {} } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens, lines, repos: [], purchases, ...extra }));
  return { world: createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => now }) };
}
const PUSH = { kind: 'frontier', at: at(0), price: 4000, earnedAt: 0, ang: 0 };
const ROCKET = { kind: 'rocket', at: at(1), price: 8000, earnedAt: 0, planet: 'p0', name: 'Vesta' };
const BUILD = { kind: 'build', at: at(2), price: 4000, earnedAt: 0, on: 'home', description: 'a SECRET-PROMPT about my-private-repo', caption: 'A ring city', pieces: [{ kind: 'ring_city', colour: '#ffc56a', size: 'large', place: 'equator', count: 4 }] };
const HAIL = { kind: 'hail', at: at(2), price: 2000, earnedAt: 0, to: { handle: 'kim' } };
/** A World with a push, a colony, a build, a cleanup day, a finished week, repos git couldn't read, over three weeks. */
function rich() {
  const tokens = {}, lines = { '/Users/someone/my-private-repo': {} };
  for (let d = 0; d < 21; d++) { tokens[key(at(d))] = 2_000_000; lines['/Users/someone/my-private-repo'][key(at(d))] = { added: 300, removed: d === 4 ? 2000 : 20, commits: 3 }; }
  return seeded({ tokens, lines, purchases: [PUSH, ROCKET, BUILD, HAIL], now: at(21), extra: { noEmail: ['/Users/someone/other-repo'], gitFailed: ['/Users/someone/slow-repo'] } }).world.summary();
}
/** What the validator hands back for a v3 projection: each colony also carries its stage's name, rebuilt from the number. */
const served = (p) => ({ ...p, planets: p.planets.map((q) => (q.colony ? { ...q, colony: { ...q.colony, stageName: colonyStageName(q.colony.stage) } } : q)) });
const PRIVATE = ['multiplier', '"active"', 'slot', 'earned', 'spent', 'balance', 'prices', 'today', 'xp', 'noEmail', 'gitFailed', 'description', 'info', 'tokens', 'added', 'removed', 'commits', 'credit', 'startedAt', '"at"', 'hail', 'kim', '/Users', 'my-private-repo', 'SECRET'];

test('the projection has exactly the public keys and nothing private in its text', () => {
  const s = rich(), p = publicProjection(s), text = JSON.stringify(p);
  assert.deepEqual(Object.keys(p), ['pv', 'seed', 'since', 'daysActive', 'worked', 'home', 'reach', 'sun', 'frontier', 'planets', 'moments', 'builds', 'probes']);
  assert.deepEqual(p.worked, Array.from({ length: 21 }, (_, d) => key(at(d))), 'the days with work in them, oldest first');
  assert.deepEqual(Object.keys(p.home), ['level', 'stage']);
  for (const word of PRIVATE) assert.equal(text.includes(word), false, `leaks ${word}`);
  assert.equal(p.pv, PROJECTION_VERSION);
  assert.equal(p.since, '2026-10-12');
  assert.equal(p.daysActive, 21);
  assert.equal(p.pv, 3);
  assert.deepEqual(Object.keys(p.planets[0].colony), ['name', 'day', 'stage']);
  assert.deepEqual([p.planets[0].colony.name, p.planets[0].colony.day, Number.isInteger(p.planets[0].colony.stage)], ['Vesta', '2026-10-13', true]);
  assert.deepEqual(p.builds, [{ id: 'b0', on: 'home', caption: 'A ring city', pieces: BUILD.pieces, day: '2026-10-14' }]);
  assert.ok(p.moments.some((m) => m.kind === 'cleanup') && p.moments.some((m) => m.kind === 'week'), 'moments kept, by kind');
  assert.deepEqual(Object.keys(p.moments.find((m) => m.kind === 'week')), ['id', 'kind', 'name', 'day', 'from', 'x', 'y']);
  assert.deepEqual(Object.keys(p.moments.find((m) => m.kind === 'cleanup')), ['id', 'kind', 'name', 'day', 'x', 'y']);
  assert.equal(publicProjection({ started: false }), null);
  assert.equal(publicProjection(undefined), null);
});

test('a version 1 projection still reads, every lobe from Home and no probes', () => {
  const v2 = publicProjection(rich()), v1 = JSON.parse(JSON.stringify(v2));
  v1.pv = 1; delete v1.probes;
  for (const l of v1.frontier) delete l.from;
  for (const q of v1.planets) if (q.colony) delete q.colony.stage;
  assert.deepEqual(validProjection(v1), served({ ...v2, planets: v2.planets.map((q) => (q.colony ? { ...q, colony: { ...q.colony, stage: 1 } } : q)), probes: [] }));
  v1.frontier[0].from = 'home';
  assert.equal(validProjection(v1), null, 'version 1 has no places');
});

test('a brand-new World projects: no purchases, no frontier, level 1', () => {
  const p = publicProjection(seeded({ tokens: {}, purchases: [] }).world.summary());
  assert.deepEqual([p.home, p.frontier, p.planets, p.builds, p.daysActive, p.worked], [{ level: 1, stage: 'Bare rock' }, [], [], [], 0, []]);
  assert.deepEqual(validProjection(p), p);
});

test('worked days: at most the latest 100 leave, a projection without the key still validates, and the list must be sorted days', () => {
  const tokens = {};
  for (let d = 0; d < 130; d++) if (d % 2 === 0) tokens[key(at(d))] = 2_000_000; // 65 worked days over 130
  const many = publicProjection(seeded({ tokens, now: at(130) }).world.summary());
  assert.equal(many.worked.length, 65);
  for (let d = 0; d < 260; d++) tokens[key(at(d))] = 2_000_000;
  const more = publicProjection(seeded({ tokens, now: at(260) }).world.summary());
  assert.equal(more.worked.length, 100);
  assert.equal(more.worked.at(-1), key(at(259)), 'the latest ones');
  assert.equal(more.daysActive, 260, 'the count still covers every day');
  const old = publicProjection(rich()); delete old.worked;
  assert.deepEqual(validProjection(old).worked, [], 'a projection from before the key is still read, with no days');
  const bad = (mutate, why) => { const p = publicProjection(rich()); mutate(p); assert.equal(validProjection(p), null, why); };
  bad((p) => { p.worked = Array.from({ length: 101 }, (_, i) => key(at(i))); }, '101 days');
  bad((p) => { p.worked = ['2026-10-13', '2026-10-12']; }, 'out of order');
  bad((p) => { p.worked = ['2026-10-12', '2026-10-12']; }, 'a day twice');
  bad((p) => { p.worked = ['2026-10-1']; }, 'a malformed day');
  bad((p) => { p.worked = 'yes'; }, 'not a list');
});

test('the projection is deterministic and round-trips through the validator unchanged', () => {
  const s = rich(), a = publicProjection(s), b = publicProjection(s);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const input = JSON.parse(JSON.stringify(a)), v = validProjection(input);
  assert.deepEqual(v, served(a));
  assert.ok(v !== input && v.home !== input.home && v.sun !== input.sun && v.planets !== input.planets && v.builds[0].pieces !== input.builds[0].pieces, 'a fresh object all the way down, never the input');
  input.home.level = 1; input.builds[0].pieces[0].count = 99;
  assert.deepEqual(v, served(a), 'changing the input afterwards does not reach the result');
});

test('the projection copies a build piece key by key: a stray field in a stored piece does not leave', () => {
  const piece = { ...BUILD.pieces[0], prompt: 'PRIVATE-NOTE' };
  const s = seeded({ tokens: { [key(at(0))]: 2_000_000 }, purchases: [PUSH, { ...BUILD, pieces: [piece] }], now: at(3) }).world.summary();
  const p = publicProjection(s);
  assert.equal(JSON.stringify(p).includes('PRIVATE-NOTE'), false);
  assert.ok(p.builds[0].pieces !== s.builds[0].pieces && p.builds[0].pieces[0] !== s.builds[0].pieces[0]);
  assert.deepEqual(p.builds[0].pieces, BUILD.pieces);
});

test('the validator refuses what the renderer must never see', () => {
  const good = publicProjection(rich()), copy = () => JSON.parse(JSON.stringify(good));
  const bad = (mutate, why) => { const p = copy(); mutate(p); assert.equal(validProjection(p), null, why); };
  bad((p) => { p.extra = 1; }, 'an extra key');
  bad((p) => { p.pv = 4; }, 'another version');
  bad((p) => { p.seed = 2 ** 31; }, 'seed out of range');
  bad((p) => { p.seed = 1.5; }, 'seed not an integer');
  bad((p) => { p.since = '2026-1-1'; }, 'a malformed day');
  bad((p) => { p.home.level = 1001; }, 'a level past 1,000');
  bad((p) => { p.home.level = 12.5; }, 'a level that is not a whole number');
  bad((p) => { p.planets[0].colony.stage = 1001; }, 'a colony stage past 1,000');
  bad((p) => { p.planets[0].colony.stage = 0; }, 'colony stage 0');
  bad((p) => { p.planets[0].colony.stage = 'City'; }, 'a colony stage that is a name');
  bad((p) => { delete p.planets[0].colony.stage; }, 'a version 3 colony without its stage');
  bad((p) => { p.home.level = 0; }, 'level 0');
  bad((p) => { p.sun.look = 'green'; }, 'a sun look off the list');
  bad((p) => { p.sun.x = Infinity; }, 'a non-finite coordinate');
  bad((p) => { p.planets[0].x = NaN; }, 'NaN');
  bad((p) => { p.planets[0].x = 1e7; }, 'a coordinate past 1e6');
  bad((p) => { p.planets[0].look = 'lava'; }, 'a planet look off the list');
  bad((p) => { p.planets[0].colony.name = 'x'.repeat(25); }, 'a 25-letter colony name');
  bad((p) => { p.planets[0].id = 'q0'; }, 'a bad planet id');
  bad((p) => { p.planets.push({ ...p.planets[0] }); }, 'a duplicate planet id');
  bad((p) => { p.builds[0].on = 'p9'; }, 'a build on a planet that is not there');
  bad((p) => { p.builds[0].pieces[0].kind = 'volcano'; }, 'a piece off the catalogue');
  bad((p) => { p.builds = Array.from({ length: 1001 }, (_, i) => ({ ...p.builds[0], id: `b${i}` })); }, '1001 builds');
  bad((p) => { p.frontier = Array.from({ length: 65 }, () => p.frontier[0] ?? { from: 'home', ang: 0, bought: 150, lit: 0, tip: 60 }); }, '65 lobes');
  bad((p) => { p.frontier[0].from = 'p9'; }, 'a lobe from a planet that is not in the projection');
  bad((p) => { delete p.frontier[0].from; }, 'a version 2 lobe without its place');
  bad((p) => { p.probes = [{ ang: 0, progress: 0.5, to: { x: 1, y: 2 } }]; }, 'a probe target before arrival');
  bad((p) => { p.probes = [{ ang: 0, progress: 1, to: { x: 1.5, y: 2 } }]; }, 'a target off the spiral');
  bad((p) => { p.probes = [{ ang: 0, progress: 2 }]; }, 'a probe past its target');
  bad((p) => { p.probes = [{ ang: 0, progress: 0.5, handle: 'kim' }]; }, 'a probe carrying anything else');
  bad((p) => { p.moments[0].kind = 'secret'; }, 'a moment kind off the list');
  bad((p) => { p.moments[0].info = { credit: 1 }; }, 'a moment carrying info');
  bad((p) => { p.builds[0].caption = 'x'.repeat(81); }, 'an 81-letter caption is refused, not cut');
  bad((p) => { p.builds[0].pieces[0].prompt = 'PRIVATE-NOTE'; }, 'a piece with an extra key is refused, not stripped');
  bad((p) => { delete p.moments.find((m) => m.kind === 'week').from; }, 'a week without its first day');
  bad((p) => { p.moments.find((m) => m.kind === 'cleanup').from = '2026-10-12'; }, 'a cleanup with a first day');
  assert.equal(validProjection(null), null);
  assert.equal(validProjection('{}'), null);
  const relabeled = copy(); relabeled.home.stage = 'Paradise';
  assert.equal(validProjection(relabeled).home.stage, LEVELS[good.home.level - 1][1], 'the stage is re-derived from the level');
});

test('a v3 projection carries Home past 12 and colony stages', () => {
  const s = rich();
  s.home = { ...s.home, level: 15, stage: levelName(15) };
  s.planets[0].colony.stage = 8;
  const p = publicProjection(s);
  assert.deepEqual(p.home, { level: 15, stage: HOME_FEATURES[2] });
  assert.equal(p.planets[0].colony.stage, 8);
  assert.deepEqual(validProjection(JSON.parse(JSON.stringify(p))), served(p), 'and it round-trips');
  for (const level of [13, 1000]) {
    const q = JSON.parse(JSON.stringify(p)); q.home = { level, stage: levelName(level) };
    assert.equal(validProjection(q).home.level, level);
  }
  const top = JSON.parse(JSON.stringify(p)); top.planets[0].colony.stage = 1000;
  assert.equal(validProjection(top).planets[0].colony.stage, 1000);
});

test('the stage names are rebuilt, never trusted', () => {
  const p = JSON.parse(JSON.stringify(publicProjection(rich())));
  p.home = { level: 20, stage: 'Paradise' };
  assert.equal(validProjection(p).home.stage, levelName(20));
  assert.equal(levelName(20), levelOf(4000 + 1000 * 8).stage, "the name is the level's own");
  for (const level of [1, 7, 12, 13, 24, 25, 40, 100]) assert.equal(levelName(level), levelOf(level <= 12 ? LEVELS[level - 1][0] : 4000 + 1000 * (level - 12)).stage, `level ${level}`);
  for (const stage of [1, 3, 6, 7, 12, 13, 30]) assert.equal(colonyStageName(stage), colonyStage(stage <= 6 ? [0, 100, 300, 700, 1300, 2000][stage - 1] : 2000 + 1000 * (stage - 6)).name, `colony stage ${stage}`);
  assert.deepEqual([colonyStageName(1), colonyStageName(6), colonyStageName(7)], ['Landing site', 'City', COLONY_FEATURES[0]]);
  assert.equal(levelName(13), HOME_FEATURES[0]);
});

test('v1 and v2 still read, exactly as before', () => {
  const v3 = publicProjection(rich()), v2 = JSON.parse(JSON.stringify(v3));
  v2.pv = 2;
  for (const q of v2.planets) if (q.colony) delete q.colony.stage;
  const read = validProjection(v2);
  assert.equal(read.pv, PROJECTION_VERSION);
  assert.equal(read.planets[0].colony.stage, 1, 'a version 2 colony reads as stage 1');
  assert.deepEqual(read.probes, v3.probes);
  const high = JSON.parse(JSON.stringify(v2)); high.home = { level: 13, stage: 'x' };
  assert.equal(validProjection(high), null, 'version 2 stops at the 12 levels');
  const staged = JSON.parse(JSON.stringify(v2)); staged.planets[0].colony.stage = 2;
  assert.equal(validProjection(staged), null, 'and has no colony stages');
  const fresh3 = JSON.parse(JSON.stringify(v3)); delete fresh3.planets[0].colony.stage;
  assert.equal(validProjection(fresh3), null, 'version 3 has them');
});

test('a colony comes out with its stage name rebuilt, whatever the input said, and the output reads again unchanged', () => {
  const p = JSON.parse(JSON.stringify(publicProjection(rich())));
  p.planets[0].colony.stage = 7;
  const v = validProjection(p);
  assert.deepEqual(Object.keys(v.planets[0].colony), ['name', 'day', 'stage', 'stageName']);
  assert.equal(v.planets[0].colony.stageName, COLONY_FEATURES[0]);
  const lied = JSON.parse(JSON.stringify(p)); lied.planets[0].colony.stageName = 'Metropolis';
  assert.equal(validProjection(lied).planets[0].colony.stageName, COLONY_FEATURES[0], 'a made-up stageName is ignored and replaced');
  assert.deepEqual(validProjection(JSON.parse(JSON.stringify(v))), v, 'validating the validated copy gives the same copy');
  const old = JSON.parse(JSON.stringify(p)); old.pv = 2; delete old.planets[0].colony.stage;
  assert.deepEqual(validProjection(old).planets[0].colony, { name: 'Vesta', day: '2026-10-13', stage: 1, stageName: 'Landing site' });
  old.planets[0].colony.stageName = 'City';
  assert.equal(validProjection(old), null, 'a version 2 colony has no stageName');
  assert.equal(JSON.stringify(publicProjection(rich())).includes('stageName'), false, 'and the Mac does not send one');
});
