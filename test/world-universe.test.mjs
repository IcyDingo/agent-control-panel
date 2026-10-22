// The sun beside Home, days active, and what of World may leave this Mac. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, sunOf, SUN_DIST, SUN_R, SUN_LOOKS, LOBE_START, PUSH_LEN } from '../world.mjs';

const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 12, 9, 0), at = (d) => T0 + d * DAY;
const key = (ms) => new Date(ms).toISOString().slice(0, 10), credit = (c) => c * 10_000;
const push = (ang, earnedAt = 0) => ({ kind: 'frontier', at: at(0), price: 4000, earnedAt, ang });
function seeded({ tokens = { [key(at(0))]: credit(30_000) }, lines = {}, purchases = [push(0)], now = at(0), extra = {} } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens, lines, repos: [], purchases, ...extra }));
  const make = () => createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => now });
  return { world: make(), file, reload: make };
}

test('the sun sits SUN_DIST from Home, the same every time for a seed, and differs between seeds', () => {
  const s = sunOf(7);
  assert.deepEqual(s, sunOf(7));
  assert.ok(Math.abs(Math.hypot(s.x, s.y) - SUN_DIST) < 1e-9);
  assert.equal(s.r, SUN_R);
  assert.ok(SUN_LOOKS.includes(s.look));
  assert.notDeepEqual([s.x, s.y], [sunOf(8).x, sunOf(8).y]);
});

test('the sun is closer than any planet the frontier can find', () => {
  assert.ok(SUN_DIST + SUN_R < LOBE_START + 0.55 * PUSH_LEN - 18, 'planets start past LOBE_START + 0.55·PUSH_LEN, off by up to 18');
});

test("summary() carries the sun and the days with work in them", () => {
  const { world, reload } = seeded({ tokens: { [key(at(0))]: credit(30), [key(at(1))]: 0, [key(at(3))]: credit(1) }, now: at(3) });
  const s = world.summary();
  assert.deepEqual(s.sun, sunOf(7));
  assert.equal(s.daysActive, 2);
  assert.deepEqual(reload().summary().sun, s.sun);
});
