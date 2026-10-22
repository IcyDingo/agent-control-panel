// Where an account lives in the hub's universe, and the windows the map asks for. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeOf, bbox } from '../hub/coords.mjs';

test('placement is deterministic, never (0,0), and every pair in the first 20,000 is more than 60 apart', () => {
  assert.deepEqual(placeOf(1), placeOf(1));
  const seen = new Map();
  for (let i = 1; i <= 20_000; i++) { const p = placeOf(i); assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y)); assert.ok(p.x !== 0 || p.y !== 0); seen.set(`${p.x},${p.y}`, i); }
  assert.equal(seen.size, 20_000, 'all distinct');
  // every pair of the 20,000: bucket the points in 60-wide cells, so a pair closer than 60 shares a cell or touches one
  const all = Array.from({ length: 20_000 }, (_, i) => ({ n: i + 1, ...placeOf(i + 1) }));
  const cells = new Map();
  for (const p of all) { const k = `${Math.floor(p.x / 60)},${Math.floor(p.y / 60)}`; (cells.get(k) ?? cells.set(k, []).get(k)).push(p); }
  let nearest = Infinity;
  for (const p of all) {
    const cx = Math.floor(p.x / 60), cy = Math.floor(p.y / 60);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const q of cells.get(`${cx + dx},${cy + dy}`) ?? []) if (q.n > p.n) nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.y - q.y));
  }
  assert.ok(nearest > 60, `the closest pair is ${nearest} apart`);
  assert.ok(Math.hypot(placeOf(50).x, placeOf(50).y) > 380 && Math.hypot(placeOf(50).x, placeOf(50).y) < 470, 'ordinal 50 lands near r 424');
});

test('the formula is frozen: these spots are permanent, so a changed constant would move every account', () => {
  // Literals computed once from the shipped implementation (SPACING 60, golden angle, JITTER 12, sha1 hex slices, rounding).
  assert.deepEqual(placeOf(1), { x: -51, y: 40 });
  assert.deepEqual(placeOf(2), { x: 16, y: -79 });
  assert.deepEqual(placeOf(50), { x: 355, y: 244 });
});

test('a window is normalised and capped', () => {
  assert.deepEqual(bbox({ x0: 10, y0: 10, x1: -10, y1: -10 }), { x0: -10, y0: -10, x1: 10, y1: 10 });
  assert.equal(bbox({ x0: 0, y0: 0, x1: 4001, y1: 0 }), null);
  assert.equal(bbox({ x0: NaN, y0: 0, x1: 1, y1: 1 }), null);
});
