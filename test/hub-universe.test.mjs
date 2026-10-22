// The hub's Universe: where a probe goes, and the names of the galaxies probes found. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, publicProjection, PROJECTION_VERSION } from '../world.mjs';
import { openDb } from '../hub/db.mjs';
import { createAccounts } from '../hub/accounts.mjs';
import { createSystems } from '../hub/systems.mjs';
import { createUniverse } from '../hub/universe.mjs';

const T0 = Date.UTC(2026, 9, 12, 9, 0);
function snapshot() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens: {}, lines: {}, repos: [], purchases: [] }));
  return publicProjection(createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => T0 }).summary());
}

/** Alice at (0, 0) and others placed by hand: Bob 100 east, Cat 50 north, Dan 300 east, Eve 20 west with no system. */
function setup() {
  const db = openDb(':memory:'), accounts = createAccounts(db, { now: () => T0 }), systems = createSystems(db, { now: () => T0 });
  const who = {};
  for (const [login, x, y, synced] of [['alice', 0, 0, true], ['bob', 100, 0, true], ['cat', 0, -50, true], ['dan', 300, 10, true], ['eve', -20, 0, false]]) {
    const a = accounts.signIn({ provider: 'github', subject: login, login }).account;
    db.prepare('UPDATE accounts SET x = ?, y = ? WHERE id = ?').run(x, y, a.id);
    if (synced) assert.equal(systems.put(a.id, { pv: PROJECTION_VERSION, seq: 1, device: 'Mac', snapshot: snapshot() }).ok, true);
    who[login] = a.id;
  }
  const hide = (login) => db.prepare("UPDATE accounts SET visibility = 'unlisted' WHERE id = ?").run(who[login]);
  return { universe: createUniverse(db), who, hide };
}
const EAST = 0, NORTH = -Math.PI / 2, WEST = Math.PI;
const handleOf = (r) => (r.ok ? r.target.handle : r.none ? 'none' : r.error);

test('a probe finds the nearest public galaxy within 30° of where it was aimed', () => {
  const { universe, who } = setup();
  assert.deepEqual(universe.target(who.alice, EAST, []), { ok: true, target: { x: 100, y: 0, handle: 'bob' } });
  assert.equal(handleOf(universe.target(who.alice, NORTH, [])), 'cat');
  assert.equal(handleOf(universe.target(who.alice, EAST + 0.5, [])), 'bob', '29° off still counts');
});

test('with no one in the cone it finds the nearest anywhere', () => {
  const { universe, who } = setup();
  assert.equal(handleOf(universe.target(who.alice, WEST, [])), 'cat', 'Eve is nearer, but has no system');
});

test('what was found or is on the way is skipped', () => {
  const { universe, who } = setup();
  assert.equal(handleOf(universe.target(who.alice, EAST, [{ x: 100, y: 0 }])), 'dan');
});

test('unlisted galaxies and yourself are never found', () => {
  const { universe, who, hide } = setup();
  hide('dan');
  assert.equal(handleOf(universe.target(who.alice, EAST, [{ x: 100, y: 0 }])), 'cat', 'Dan unlisted: the nearest anywhere');
  assert.equal(handleOf(universe.target(who.bob, WEST, [])), 'alice', 'from Bob, west is Alice, never Bob');
});

test('no one new answers none', () => {
  const { universe, who } = setup();
  assert.deepEqual(universe.target(who.alice, EAST, [{ x: 100, y: 0 }, { x: 0, y: -50 }, { x: 300, y: 10 }]), { ok: false, none: true });
});

test('the names of found galaxies: listed ones with a system, with their sun', () => {
  const { universe, hide } = setup();
  hide('cat');
  const named = universe.named([{ x: 100, y: 0 }, { x: 0, y: -50 }, { x: -20, y: 0 }, { x: 7, y: 7 }]);
  assert.deepEqual(named.map((g) => [g.x, g.y, g.handle]), [[100, 0, 'bob']]);
  assert.deepEqual(Object.keys(named[0]), ['x', 'y', 'handle', 'name', 'avatar', 'look']);
  assert.equal(named[0].look, snapshot().sun.look);
});
