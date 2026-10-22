// World stage 2: pushing the frontier, the planets it finds, and the moments on the map. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorld, frontierOf, priceOf, PRICES, PUSH_LEN, LIGHT_CREDIT, LOBE_START, lobeRadius, homeReach, walledIn } from '../world.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 12, 9, 0); // a Monday
const at = (d, h = 9) => T0 + d * DAY + (h - 9) * 3_600_000;
const key = (ms) => new Date(ms).toISOString().slice(0, 10);
/** A World saved with this much work per day (`tokens`: 10,000 tokens is 1 credit), opened at T0, looked at `now`. */
function seeded({ tokens = {}, lines = {}, purchases = [], peak, now = at(0) } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens, lines, repos: [], purchases, ...(peak ? { peak } : {}) }));
  const clock = { now };
  const world = createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => clock.now });
  return { world, file, clock, reload: () => createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => clock.now }) };
}
const credit = (c) => c * 10_000; // tokens for c credit
const saved = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a push and a rocket cost 4,000 every time, like a build', () => {
  assert.deepEqual(PRICES, { frontier: 4000, rocket: 4000, build: 4000 });
  assert.equal(priceOf('frontier', []), 4000);
  const two = [{ kind: 'frontier', price: 4000 }, { kind: 'frontier', price: 5000 }, { kind: 'rocket', price: 8000 }];
  assert.equal(priceOf('frontier', two), 4000, 'pushes bought before do not raise it');
  assert.equal(priceOf('rocket', two), 4000, 'nor do rockets');
});

test('a build costs the same wherever it goes, however many came before', () => {
  const builds = [{ kind: 'build', on: 'home' }, { kind: 'build', on: 'p0' }, { kind: 'build', on: 'home' }];
  assert.equal(priceOf('build', []), 4000);
  assert.equal(priceOf('build', builds), 4000);
  assert.equal(priceOf('build', [...builds, { kind: 'frontier' }, { kind: 'rocket' }]), 4000);
});

test('the summary carries the prices', () => {
  const { world } = seeded();
  assert.deepEqual(world.summary().prices, { frontier: 4000, rocket: 4000, build: 4000 });
});

test('a push needs the full price', () => {
  const { world, file } = seeded({ tokens: { [key(at(0))]: credit(3999) } });
  assert.deepEqual(world.buy({ kind: 'frontier', ang: 0 }), { ok: false, error: 'It costs 4,000 credit, and you have 3,999.' });
  assert.equal(saved(file).purchases.length, 0);
});

test('a push needs a direction, and nothing else can be bought this way', () => {
  const { world } = seeded({ tokens: { [key(at(0))]: credit(9000) } });
  assert.equal(world.buy({ kind: 'frontier', ang: 'north' }).ok, false);
  assert.equal(world.buy({ kind: 'frontier' }).ok, false);
  assert.equal(world.buy({ kind: 'castle' }).ok, false);
});

test('a push is spent, stored with its price, and the balance drops', () => {
  const { world, file } = seeded({ tokens: { [key(at(0))]: credit(9000) } });
  const r = world.buy({ kind: 'frontier', ang: 7 }); // past a full turn: kept as the same direction
  assert.equal(r.ok, true);
  const p = saved(file).purchases[0];
  assert.deepEqual({ kind: p.kind, price: p.price, earnedAt: p.earnedAt, at: p.at }, { kind: 'frontier', price: 4000, earnedAt: 9000, at: at(0) });
  assert.ok(Math.abs(p.ang - (7 - 2 * Math.PI)) < 1e-9);
  const s = world.summary();
  assert.deepEqual([s.spent, s.balance, s.prices.frontier], [4000, 5000, 4000]);
});

test('a new lobe starts dark and lights up as credit is earned after the push', () => {
  const { world, clock, file, reload } = seeded({ tokens: { [key(at(0))]: credit(9000) } });
  world.buy({ kind: 'frontier', ang: 0 });
  let lobes = world.summary().frontier;
  assert.equal(lobes.length, 1);
  assert.deepEqual([lobes[0].ang, lobes[0].bought], [0, PUSH_LEN]);
  assert.equal(lobes[0].lit, 0, 'nothing earned since');
  const st = saved(file);
  st.tokens[key(at(1))] = credit(LIGHT_CREDIT / 2);
  fs.writeFileSync(file, JSON.stringify(st));
  clock.now = at(1);
  assert.equal(reload().summary().frontier[0].lit, PUSH_LEN / 2, 'half lit after half of LIGHT_CREDIT');
  st.tokens[key(at(2))] = credit(LIGHT_CREDIT * 5);
  fs.writeFileSync(file, JSON.stringify(st));
  clock.now = at(2);
  assert.equal(reload().summary().frontier[0].lit, PUSH_LEN, 'never more than it bought');
});

test('a push near an existing lobe extends it; one elsewhere starts another', () => {
  const near = 15 * Math.PI / 180, far = Math.PI / 2;
  const { world } = seeded({ tokens: { [key(at(0))]: credit(40_000) } });
  world.buy({ kind: 'frontier', ang: 0 });
  world.buy({ kind: 'frontier', ang: near });
  world.buy({ kind: 'frontier', ang: far });
  const lobes = world.summary().frontier;
  assert.deepEqual(lobes.map((l) => [Math.round(l.ang * 100) / 100, l.bought]), [[0, 2 * PUSH_LEN], [1.57, PUSH_LEN]]);
});

test('a lit lobe never shrinks when a day is worth less on a later count', () => {
  const day = key(at(0));
  const { world, file, reload } = seeded({ tokens: { [day]: credit(4000) } });
  world.buy({ kind: 'frontier', ang: 0 });
  const st = saved(file);
  st.tokens[key(at(1))] = credit(LIGHT_CREDIT);
  st.peak = 7000; // what World had seen: 4,000 + 3,000
  st.lines = { '/r': { [key(at(1))]: { added: 30_000, removed: 0, commits: 1 } } };
  st.tokens[key(at(1))] = 0; // the same day now counts 3,000 from lines instead
  fs.writeFileSync(file, JSON.stringify(st));
  assert.equal(reload().summary().frontier[0].lit, PUSH_LEN);
  st.lines = {};
  fs.writeFileSync(file, JSON.stringify(st));
  assert.equal(reload().summary().frontier[0].lit, PUSH_LEN, 'earned fell to 4,000, the light stays');
});

test('the highest earned is remembered across restarts', async () => {
  const { world, file } = seeded({ tokens: { [key(at(0))]: credit(5000) } });
  await world.scan({ git: false });
  assert.equal(saved(file).peak, 5000);
});

test('lobes widen toward their tip, the shape the mockup drew', () => {
  assert.equal(lobeRadius(0, 100), 34);
  assert.ok(lobeRadius(100, 100) > lobeRadius(50, 100));
  assert.ok(homeReach(0) === 46 && homeReach(4000) === 166 && homeReach(400) > 46);
});

test('the first push finds a planet, out in its stretch, once the light reaches it', () => {
  const { world, file, reload, clock } = seeded({ tokens: { [key(at(0))]: credit(4000) } });
  world.buy({ kind: 'frontier', ang: 0 });
  assert.deepEqual(world.summary().planets, [], 'not before the light reaches it');
  const st = saved(file);
  st.tokens[key(at(1))] = credit(LIGHT_CREDIT);
  fs.writeFileSync(file, JSON.stringify(st));
  clock.now = at(1);
  const [p] = reload().summary().planets;
  assert.equal(p.id, 'p0');
  assert.equal(p.colony, null);
  assert.ok(p.x > LOBE_START && p.x < LOBE_START + PUSH_LEN && Math.abs(p.y) < 20, `in the lobe, east of Home (got ${p.x}, ${p.y})`);
  assert.ok(['rust', 'ice', 'sand', 'violet'].includes(p.look));
});

test('later pushes find a planet about half the time, the same ones every time', () => {
  const tokens = { [key(at(0))]: credit(400_000), [key(at(1))]: credit(400_000) };
  const pushes = Array.from({ length: 12 }, (_, i) => ({ kind: 'frontier', at: at(0), price: 4000, earnedAt: 0, ang: (i * 2 * Math.PI) / 12 - Math.PI + 0.01 }));
  const { world, reload } = seeded({ tokens, purchases: pushes, now: at(1) });
  const ids = world.summary().planets.map((p) => p.id);
  assert.ok(ids.includes('p0'));
  assert.deepEqual(reload().summary().planets.map((p) => p.id), ids);
  let found = 0;
  for (let seed = 1; seed <= 200; seed++) found += frontierOf(pushes, 1e9, seed).planets.length - 1; // all but the first push's
  assert.ok(Math.abs(found / (200 * 11) - 0.5) < 0.05, `about half of the later pushes, over 200 worlds (got ${found / 2200})`);
});

test('a finished week becomes a moment with what was done; this week waits for Sunday', () => {
  const tokens = { [key(at(0))]: credit(1000), [key(at(2))]: credit(500), [key(at(8))]: credit(200) };
  const lines = { '/r': { [key(at(2))]: { added: 900, removed: 100, commits: 4 } } };
  const { world } = seeded({ tokens, lines, now: at(9) }); // the second week's Tuesday
  const weeks = world.summary().moments.filter((m) => m.kind === 'week');
  assert.equal(weeks.length, 1);
  const w = weeks[0];
  assert.equal(w.day, key(at(6)), "dated by the week's Sunday");
  assert.equal(w.from, key(at(0)));
  assert.deepEqual(w.info, { commits: 4, added: 900, removed: 100, credit: 1000 + Math.round((90 + 500) * 1.3), days: 2 });
});

test('a finished day that removed more than it added, 500 lines or more, is a big cleanup', () => {
  const lines = { '/r': { [key(at(1))]: { added: 100, removed: 900, commits: 2 }, [key(at(2))]: { added: 900, removed: 600, commits: 1 },
    [key(at(3))]: { added: 0, removed: 800, commits: 1 } } };
  const { world } = seeded({ lines, now: at(3) });
  const cleanups = world.summary().moments.filter((m) => m.kind === 'cleanup');
  assert.deepEqual(cleanups.map((m) => m.day), [key(at(1))], 'not one that added more, nor today until it ends');
  assert.deepEqual(cleanups[0].info, { added: 100, removed: 900, multiplier: 3.7, credit: Math.round(10 * 3.7) });
});

test('Home reaching level 3 and up is a moment on the day it happened', () => {
  const tokens = { [key(at(0))]: credit(300), [key(at(1))]: credit(300), [key(at(2))]: credit(300) }; // 100 XP a day
  const { world } = seeded({ tokens, now: at(2, 20) });
  const levels = world.summary().moments.filter((m) => m.kind === 'level');
  assert.deepEqual(levels.map((m) => [m.day, m.name]), [[key(at(0)), 'Home: Oceans'], [key(at(2)), 'Home: Continents']], 'today’s too: a level is reached at once');
  assert.deepEqual(levels[0].info, { level: 3, xp: 100 });
});

test('moments sit in the light: in Home’s before any push, along the lobe growing when they happened', () => {
  const tokens = {};
  for (let d = 0; d < 21; d++) tokens[key(at(d))] = credit(800);
  const push = { kind: 'frontier', at: at(7, 12), price: 4000, earnedAt: 6400, ang: Math.PI / 2 };
  const { world, reload } = seeded({ tokens, purchases: [push], now: at(21) });
  const s = world.summary(), reach = s.reach;
  const [lobe] = s.frontier, ux = Math.cos(lobe.ang), uy = Math.sin(lobe.ang);
  const weeks = s.moments.filter((m) => m.kind === 'week');
  assert.equal(weeks.length, 3);
  const [first, second] = weeks;
  assert.ok(Math.hypot(first.x, first.y) < reach, 'the week before the push sits in Home’s light');
  const along = second.x * ux + second.y * uy, off = Math.abs(second.x * -uy + second.y * ux);
  assert.equal(lobe.tip, LOBE_START + lobe.lit);
  assert.ok(along > 0 && along <= lobe.tip && off <= lobeRadius(along, lobe.tip), `the week after sits in the lobe (along ${along}, off ${off})`);
  assert.deepEqual(reload().summary().moments, s.moments, 'and stays put');
});

// ---------------------------------------------------------------- pushing from a colony

const PUSH0 = { kind: 'frontier', at: at(0), price: 4000, earnedAt: 0, ang: 0 };
const VESTA = { kind: 'rocket', at: at(0), price: 4000, earnedAt: 0, planet: 'p0', name: 'Vesta' };
const fromVesta = (ang, extra = {}) => ({ kind: 'frontier', at: at(0), price: 4000, earnedAt: 0, ang, from: 'p0', ...extra });
/** How far a point is from the segment `a` → `b`. */
const toSegment = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - a.x - k * dx, p.y - a.y - k * dy);
};

test('a push leaves from a colony, starting 30 px out from it', () => {
  const { lobes, planets } = frontierOf([PUSH0, VESTA, fromVesta(Math.PI / 2)], 1e9, 7);
  const p0 = planets.find((p) => p.id === 'p0'), l = lobes[1];
  assert.deepEqual([l.from, l.ox, l.oy, l.start], ['p0', p0.x, p0.y, 30]);
  assert.equal(l.tip, 30 + PUSH_LEN, 'lit all the way');
  assert.deepEqual([lobes[0].from, lobes[0].ox, lobes[0].oy, lobes[0].start], ['home', 0, 0, LOBE_START]);
  for (const q of planets.filter((q) => q.lobe === l)) assert.ok(toSegment(q, { x: l.ox, y: l.oy }, { x: l.ox, y: l.oy + l.tip }) < 20, 'out along the colony lobe');
});

test('pushes join only from the same place', () => {
  const two = frontierOf([PUSH0, VESTA, fromVesta(0.1)], 1e9, 7).lobes;
  assert.deepEqual(two.map((l) => [l.from, l.pushes.length]), [['home', 1], ['p0', 1]], 'a colony push near a Home lobe starts its own');
  const joined = frontierOf([PUSH0, VESTA, fromVesta(0.1), fromVesta(0.15)], 1e9, 7).lobes;
  assert.deepEqual(joined.map((l) => [l.from, l.pushes.length]), [['home', 1], ['p0', 2]]);
});

test('a push from a bare planet, an unknown place or a planet not found is refused', () => {
  const bare = seeded({ tokens: { [key(at(0))]: credit(30_000) }, purchases: [PUSH0] });
  for (const from of ['p0', 'p9', 'nowhere', 7]) {
    assert.deepEqual(bare.world.buy({ kind: 'frontier', ang: 0, from }), { ok: false, error: 'Push from Home or one of your colonies.' }, String(from));
  }
  assert.equal(saved(bare.file).purchases.length, 1);
});

test('a push from a colony is kept with where it left from; one from Home keeps none', () => {
  const { world, file } = seeded({ tokens: { [key(at(0))]: credit(30_000) }, purchases: [PUSH0, VESTA] });
  assert.equal(world.buy({ kind: 'frontier', ang: 1, from: 'p0' }).ok, true);
  assert.equal(world.buy({ kind: 'frontier', ang: 2, from: 'home' }).ok, true);
  assert.equal(world.buy({ kind: 'frontier', ang: 3 }).ok, true);
  const [a, b, c] = saved(file).purchases.slice(-3);
  assert.equal(a.from, 'p0');
  assert.ok(!('from' in b) && !('from' in c));
  assert.deepEqual(world.summary().frontier.map((l) => l.from), ['home', 'p0', 'home', 'home']);
});

test('a push with no from is from Home, and the summary is as it was', () => {
  const { world } = seeded({ tokens: { [key(at(0))]: credit(30_000) }, purchases: [PUSH0] });
  assert.deepEqual(world.summary().frontier, [{ from: 'home', ang: 0, bought: PUSH_LEN, lit: PUSH_LEN, tip: LOBE_START + PUSH_LEN }]);
});

test('a moment along a colony lobe sits along that lobe', () => {
  const tokens = {};
  for (let d = 0; d < 5; d++) tokens[key(at(d))] = credit(2_000);
  const { world } = seeded({ tokens, purchases: [PUSH0, VESTA, fromVesta(Math.PI / 2)], now: at(8) });
  const s = world.summary(), p0 = s.planets.find((p) => p.id === 'p0'), l = s.frontier[1];
  const week = s.moments.find((m) => m.kind === 'week');
  assert.ok(week, 'the week is a moment');
  assert.ok(toSegment(week, p0, { x: p0.x, y: p0.y + l.tip }) <= lobeRadius(l.tip, l.tip), 'inside the colony lobe');
});

// ---------------------------------------------------------------- dark walled in by light

/** A 9×9 grid lit 1 on the square ring 3 cells from the middle, 0 elsewhere; `gap` leaves one cell of the ring dark. */
function ring({ gap = false } = {}) {
  const n = 9, g = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (Math.max(Math.abs(i - 4), Math.abs(j - 4)) === 3) g[j * n + i] = 1;
  if (gap) g[1 * n + 4] = 0;
  return { n, g };
}

test('a ring of light fills the dark inside it', () => {
  const { n, g } = ring(), out = walledIn(g, n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const d = Math.max(Math.abs(i - 4), Math.abs(j - 4));
    assert.equal(out[j * n + i], d <= 3 ? 1 : 0, `${i},${j}`);
  }
});

test('a gap in the ring lets the dark out', () => {
  const { n, g } = ring({ gap: true }), out = walledIn(g, n);
  assert.equal(out[4 * n + 4], 0, 'the middle stays dark');
  assert.equal(out[1 * n + 4], 0, 'and so does the gap');
});

test('light is never dimmed, and the grid passed in is left alone', () => {
  const n = 5, g = new Float32Array(n * n).map((_, k) => (k % 3) * 0.4), before = [...g], out = walledIn(g, n);
  assert.deepEqual([...g], before);
  for (let k = 0; k < n * n; k++) assert.ok(out[k] >= g[k]);
  for (let k = 0; k < n * n; k++) if (g[k] >= 0.3) assert.equal(out[k], g[k]);
});
