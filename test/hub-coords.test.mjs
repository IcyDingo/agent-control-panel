// Where an account lives in the hub's universe, and the windows the map asks for. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeOf, bbox } from '../hub/coords.mjs';

test('placement is deterministic, never (0,0), and every pair in the first 20,000 is more than 60 apart', () => {
  assert.deepEqual(placeOf(1), placeOf(1));
  const seen = new Map();
  for (let i = 1; i <= 20_000; i++) { const p = placeOf(i); assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y)); assert.ok(p.x !== 0 || p.y !== 0); seen.set(`${p.x},${p.y}`, i); }
  assert.equal(seen.size, 20_000, 'all distinct');
  // the ring of ordinals 1..400 against each other, exhaustively; the rest by the spiral's spacing
  const pts = Array.from({ length: 400 }, (_, i) => placeOf(i + 1));
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) > 60, `${i + 1} vs ${j + 1}`);
  assert.ok(Math.hypot(placeOf(50).x, placeOf(50).y) > 380 && Math.hypot(placeOf(50).x, placeOf(50).y) < 470, 'ordinal 50 lands near r 424');
});

test('a window is normalised and capped', () => {
  assert.deepEqual(bbox({ x0: 10, y0: 10, x1: -10, y1: -10 }), { x0: -10, y0: -10, x1: 10, y1: 10 });
  assert.equal(bbox({ x0: 0, y0: 0, x1: 4001, y1: 0 }), null);
  assert.equal(bbox({ x0: NaN, y0: 0, x1: 1, y1: 1 }), null);
});
