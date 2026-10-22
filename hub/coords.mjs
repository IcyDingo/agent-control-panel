// Where every account lives in the hub's universe, and the window the map may ask about.
// Each account gets a permanent spot in a sunflower spiral (r = SPACING·√n, each step the golden angle round), nudged by a
// hashed jitter so it does not look like a grid. The spiral keeps neighbours about 106 apart at SPACING 60, so even with
// the jitter (at most ~34 between two points) every pair stays more than 60 apart. Pure functions, no state.
import crypto from 'node:crypto';

export const SPACING = 60, JITTER = 12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Two numbers in [0, 1) that are always the same for this ordinal (as world.mjs's hash: 8 hex chars each). */
function hash2(ordinal) {
  const hex = crypto.createHash('sha1').update(String(ordinal)).digest('hex');
  return [parseInt(hex.slice(0, 8), 16) / 2 ** 32, parseInt(hex.slice(8, 16), 16) / 2 ** 32];
}

/** The permanent spot (integers) of the account with this ordinal (1, 2, 3, …, in sign-up order). */
export function placeOf(ordinal) {
  const r = SPACING * Math.sqrt(ordinal), a = ordinal * GOLDEN_ANGLE;
  const [jx, jy] = hash2(ordinal);
  return {
    x: Math.round(r * Math.cos(a) + (jx * 2 - 1) * JITTER),
    y: Math.round(r * Math.sin(a) + (jy * 2 - 1) * JITTER),
  };
}

/** A window with its corners in order, or null when a value is not a finite number or a side is longer than `max`. */
export function bbox({ x0, y0, x1, y1 } = {}, max = 4000) {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const w = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  return w.x1 - w.x0 > max || w.y1 - w.y0 > max ? null : w;
}
