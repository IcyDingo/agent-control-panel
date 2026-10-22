// What of World may leave this Mac: the shape of the system, never the numbers that paid for it. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, publicProjection, validProjection, PROJECTION_VERSION, LEVELS } from '../world.mjs';

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
const PRIVATE = ['earned', 'spent', 'balance', 'prices', 'today', 'xp', 'noEmail', 'gitFailed', 'description', 'info', 'tokens', 'added', 'removed', 'commits', 'credit', 'startedAt', '"at"', 'hail', 'kim', '/Users', 'my-private-repo', 'SECRET'];

test('the projection has exactly the public keys and nothing private in its text', () => {
  const s = rich(), p = publicProjection(s), text = JSON.stringify(p);
  assert.deepEqual(Object.keys(p), ['pv', 'seed', 'since', 'daysActive', 'home', 'reach', 'sun', 'frontier', 'planets', 'moments', 'builds']);
  assert.deepEqual(Object.keys(p.home), ['level', 'stage']);
  for (const word of PRIVATE) assert.equal(text.includes(word), false, `leaks ${word}`);
  assert.equal(p.pv, PROJECTION_VERSION);
  assert.equal(p.since, '2026-10-12');
  assert.equal(p.daysActive, 21);
  assert.deepEqual(p.planets[0].colony, { name: 'Vesta', day: '2026-10-13' });
  assert.deepEqual(p.builds, [{ id: 'b0', on: 'home', caption: 'A ring city', pieces: BUILD.pieces, day: '2026-10-14' }]);
  assert.ok(p.moments.some((m) => m.kind === 'cleanup') && p.moments.some((m) => m.kind === 'week'), 'moments kept, by kind');
  assert.deepEqual(Object.keys(p.moments.find((m) => m.kind === 'week')), ['id', 'kind', 'name', 'day', 'from', 'x', 'y']);
  assert.deepEqual(Object.keys(p.moments.find((m) => m.kind === 'cleanup')), ['id', 'kind', 'name', 'day', 'x', 'y']);
  assert.equal(publicProjection({ started: false }), null);
  assert.equal(publicProjection(undefined), null);
});

test('a brand-new World projects: no purchases, no frontier, level 1', () => {
  const p = publicProjection(seeded({ tokens: {}, purchases: [] }).world.summary());
  assert.deepEqual([p.home, p.frontier, p.planets, p.builds, p.daysActive], [{ level: 1, stage: 'Bare rock' }, [], [], [], 0]);
  assert.deepEqual(validProjection(p), p);
});

test('the projection is deterministic and round-trips through the validator unchanged', () => {
  const s = rich(), a = publicProjection(s), b = publicProjection(s);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const v = validProjection(JSON.parse(JSON.stringify(a)));
  assert.deepEqual(v, a);
  assert.notEqual(v, a, 'a fresh object, never the input');
});

test('the validator refuses what the renderer must never see', () => {
  const good = publicProjection(rich()), copy = () => JSON.parse(JSON.stringify(good));
  const bad = (mutate, why) => { const p = copy(); mutate(p); assert.equal(validProjection(p), null, why); };
  bad((p) => { p.extra = 1; }, 'an extra key');
  bad((p) => { p.pv = 2; }, 'another version');
  bad((p) => { p.seed = 2 ** 31; }, 'seed out of range');
  bad((p) => { p.seed = 1.5; }, 'seed not an integer');
  bad((p) => { p.since = '2026-1-1'; }, 'a malformed day');
  bad((p) => { p.home.level = LEVELS.length + 1; }, 'a level past the ladder');
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
  bad((p) => { p.frontier = Array.from({ length: 65 }, () => p.frontier[0] ?? { ang: 0, bought: 150, lit: 0, tip: 60 }); }, '65 lobes');
  bad((p) => { p.moments[0].kind = 'secret'; }, 'a moment kind off the list');
  bad((p) => { p.moments[0].info = { credit: 1 }; }, 'a moment carrying info');
  assert.equal(validProjection(null), null);
  assert.equal(validProjection('{}'), null);
  const relabeled = copy(); relabeled.home.stage = 'Paradise';
  assert.equal(validProjection(relabeled).home.stage, LEVELS[good.home.level - 1][1], 'the stage is re-derived from the level');
});
