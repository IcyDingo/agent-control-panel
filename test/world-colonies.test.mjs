// World stage 3: rockets to the planets the frontier found, and the colonies they land. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorld, frontierOf } from '../world.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 12, 9, 0);
const at = (d) => T0 + d * DAY;
const key = (ms) => new Date(ms).toISOString().slice(0, 10);
const credit = (c) => c * 10_000; // tokens for c credit
const saved = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const push = (ang, earnedAt = 0) => ({ kind: 'frontier', at: at(0), price: 4000, earnedAt, ang });
/** Pushes in four directions, every one long since lit: the planets they found, with seed 7. */
const FOUR = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((a) => push(a));
const found = frontierOf(FOUR, 1e9, 7).planets.filter((p) => p.found).map((p) => p.id);

/** A World that earned `earned` credit (all on day 0) and bought `purchases`. */
function seeded({ earned = 30_000, purchases = [push(0)], now = at(0) } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens: { [key(at(0))]: credit(earned) }, lines: {}, repos: [], purchases }));
  const make = () => createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => now });
  return { world: make(), file, reload: make };
}

test('the four pushes the tests use find at least two planets', () => {
  assert.ok(found.length >= 2, `found ${found}`);
  assert.equal(found[0], 'p0', 'the first push always finds one');
});

test('a rocket lands a colony on a planet the frontier found, and costs what it says', () => {
  const { world, file } = seeded();
  assert.deepEqual(world.summary().planets.map((p) => [p.id, p.colony]), [['p0', null]]);
  const r = world.buy({ kind: 'rocket', planet: 'p0', name: 'Vesta' });
  assert.equal(r.ok, true, r.error);
  const p = saved(file).purchases.at(-1);
  assert.deepEqual({ kind: p.kind, price: p.price, planet: p.planet, name: p.name, at: p.at }, { kind: 'rocket', price: 8000, planet: 'p0', name: 'Vesta', at: at(0) });
  const s = world.summary();
  assert.deepEqual(s.planets[0].colony, { name: 'Vesta', at: at(0) });
  assert.deepEqual([s.spent, s.balance, s.prices.rocket], [12_000, 18_000, 10_000]);
});

test('a colony is kept: it is there after a restart', () => {
  const { world, reload } = seeded();
  world.buy({ kind: 'rocket', planet: 'p0', name: 'Vesta' });
  assert.equal(reload().summary().planets[0].colony.name, 'Vesta');
});

test('a rocket needs the full price', () => {
  const { world, file } = seeded({ earned: 11_999 });
  assert.deepEqual(world.buy({ kind: 'rocket', planet: 'p0', name: 'Vesta' }), { ok: false, error: 'It costs 8,000 credit, and you have 7,999.' });
  assert.equal(saved(file).purchases.length, 1);
});

test('a rocket only goes to a planet the frontier has found', () => {
  const dark = seeded({ purchases: [push(0, 30_000)] }); // pushed just now: nothing lit yet
  assert.equal(dark.world.summary().planets.length, 0);
  assert.deepEqual(dark.world.buy({ kind: 'rocket', planet: 'p0', name: 'Vesta' }), { ok: false, error: "The frontier hasn't found that planet yet." });
  const { world } = seeded();
  assert.equal(world.buy({ kind: 'rocket', planet: 'p7', name: 'Vesta' }).ok, false);
  assert.equal(world.buy({ kind: 'rocket', name: 'Vesta' }).ok, false);
  assert.equal(world.buy({ kind: 'rocket', planet: 'home', name: 'Vesta' }).ok, false);
});

test('one colony per planet', () => {
  const { world, file } = seeded();
  world.buy({ kind: 'rocket', planet: 'p0', name: 'Vesta' });
  assert.deepEqual(world.buy({ kind: 'rocket', planet: 'p0', name: 'Ceres' }), { ok: false, error: 'Vesta is already there.' });
  assert.equal(saved(file).purchases.length, 2);
});

test('a colony needs a name: letters, digits, spaces, apostrophes and hyphens, up to 24', () => {
  const { world } = seeded();
  const bad = 'Name the colony: up to 24 letters, digits, spaces, apostrophes or hyphens.';
  for (const name of [undefined, '', '   ', 'A'.repeat(25), '<b>Vesta</b>', 'Vesta!', "''", '--', 7])
    assert.deepEqual(world.buy({ kind: 'rocket', planet: 'p0', name }), { ok: false, error: bad }, String(name));
  assert.deepEqual(world.buy({ kind: 'rocket', planet: 'p0', name: ' home ' }), { ok: false, error: 'Home is taken. Pick another name.' });
  assert.equal(world.summary().planets[0].colony, null, 'nothing landed');
});

test('a name is tidied, and any language works', () => {
  const { world } = seeded();
  assert.equal(world.buy({ kind: 'rocket', planet: 'p0', name: "  New   O'Hara-2 " }).ok, true);
  assert.equal(world.summary().planets[0].colony.name, "New O'Hara-2");
  const other = seeded();
  assert.equal(other.world.buy({ kind: 'rocket', planet: 'p0', name: 'Ærøskøbing' }).ok, true);
});

test('two colonies cannot share a name', () => {
  const { world } = seeded({ earned: 60_000, purchases: FOUR });
  assert.equal(world.buy({ kind: 'rocket', planet: found[0], name: 'Vesta' }).ok, true);
  assert.deepEqual(world.buy({ kind: 'rocket', planet: found[1], name: 'VESTA' }), { ok: false, error: 'Vesta is taken. Pick another name.' });
  assert.equal(world.buy({ kind: 'rocket', planet: found[1], name: 'Ceres' }).ok, true);
  const s = world.summary();
  assert.deepEqual(s.planets.filter((p) => p.colony).map((p) => p.colony.name), ['Vesta', 'Ceres']);
  assert.deepEqual([s.prices.rocket, s.prices.frontier], [12_500, 9_800], 'rockets rise on their own');
});
