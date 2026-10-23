// Probes: sent from your spot in the Universe, aimed by the hub, arriving as you earn. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createWorld, publicProjection, validProjection, PRICES, PROBE_TRAVEL, PUSH_LEN } from '../world.mjs';

const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 12, 9, 0), at = (d) => T0 + d * DAY, key = (ms) => new Date(ms).toISOString().slice(0, 10);
const credit = (c) => c * 10_000;
const saved = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** A World that earned `earned` credit on day 0 and bought `purchases`; `clock.now` and `tokens` can move later. */
function seeded({ earned = 10_000, purchases = [] } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'world-')), 'world.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, startedAt: T0, seed: 7, files: {}, tokens: { [key(at(0))]: credit(earned) }, lines: {}, repos: [], purchases }));
  const make = () => createWorld({ file, configDirs: [], run: async () => ({ stdout: '' }), gitPlace: () => null, now: () => at(0) });
  return { world: make(), file, reload: make };
}
/** Earn `more` credit on top of what the file has, as a scan would, and look again. */
function earn(file, more) {
  const st = saved(file);
  st.tokens[key(at(0))] += credit(more);
  fs.writeFileSync(file, JSON.stringify(st));
}
const ME = { x: 10, y: 20 }, KIM = { x: 120, y: -40, handle: 'kim' };
/** A stand-in for the hub: answers `answer` and remembers what it was asked. */
const finder = (answer = { ok: true, target: KIM }) => { const asked = []; const find = async (ang, skip) => { asked.push({ ang, skip }); return answer; }; return Object.assign(find, { asked }); };
const PROBE = (by, to, extra = {}) => ({ kind: 'probe', at: at(0), price: 4000, earnedAt: 0, ang: 0, by, to, ...extra });

test('a probe costs 400, asks the hub where it goes, and keeps where it was sent from and to', async () => {
  assert.equal(PRICES.probe, 400);
  const { world, file } = seeded(), find = finder();
  assert.equal(world.summary().prices.probe, 400);
  const r = await world.probe({ ang: 1, me: ME, find });
  assert.equal(r.ok, true, r.error);
  const p = saved(file).purchases.at(-1);
  assert.deepEqual({ kind: p.kind, price: p.price, ang: p.ang, by: p.by, to: p.to, at: p.at, travel: p.travel },
    { kind: 'probe', price: 400, ang: 1, by: ME, to: { x: 120, y: -40 }, at: at(0), travel: 500 });
  assert.equal(world.summary().balance, 9600);
  assert.deepEqual(find.asked, [{ ang: 1, skip: [] }]);
});

test('nothing is spent when the hub has no one new, or cannot be reached', async () => {
  const { world, file } = seeded();
  assert.deepEqual(await world.probe({ ang: 0, me: ME, find: finder({ ok: false, none: true }) }), { ok: false, error: "There's no one new to find yet. Nothing was spent." });
  assert.deepEqual(await world.probe({ ang: 0, me: ME, find: finder({ ok: false, error: 'The hub could not be reached.' }) }),
    { ok: false, error: "The hub can't be reached, so a probe can't be aimed. Try again later." });
  assert.deepEqual(await world.probe({ ang: 0, me: ME, find: async () => { throw new Error('boom'); } }),
    { ok: false, error: "The hub can't be reached, so a probe can't be aimed. Try again later." });
  assert.equal(saved(file).purchases.length, 0);
});

test('signed out, a probe cannot be sent, and a probe needs a direction', async () => {
  const { world } = seeded(), find = finder();
  assert.deepEqual(await world.probe({ ang: 0, me: null, find }), { ok: false, error: 'Sign in to send a probe.' });
  assert.deepEqual(await world.probe({ ang: 'north', me: ME, find }), { ok: false, error: 'Pick a direction to send it.' });
  assert.equal(find.asked.length, 0);
});

test('the balance is checked before asking and again after', async () => {
  const poor = seeded({ earned: 399 }), find = finder();
  assert.deepEqual(await poor.world.probe({ ang: 0, me: ME, find }), { ok: false, error: 'It costs 400 credit, and you have 399.' });
  assert.equal(find.asked.length, 0, 'the hub is not asked');
  const { world, file } = seeded({ earned: 699 });
  let answer;
  const slow = () => new Promise((resolve) => { answer = resolve; });
  const pending = world.probe({ ang: 0, me: ME, find: slow });
  assert.equal(world.buy({ kind: 'frontier', ang: 1 }).ok, true, 'a push spends 300 meanwhile');
  answer({ ok: true, target: KIM });
  assert.deepEqual(await pending, { ok: false, error: 'It costs 400 credit, and you have 399. Nothing was spent.' });
  assert.equal(saved(file).purchases.filter((p) => p.kind === 'probe').length, 0);
});

test('one probe is aimed at a time', async () => {
  const { world } = seeded();
  let answer;
  const first = world.probe({ ang: 0, me: ME, find: () => new Promise((resolve) => { answer = resolve; }) });
  assert.deepEqual(await world.probe({ ang: 1, me: ME, find: finder() }), { ok: false, error: 'A probe is being aimed already.' });
  answer({ ok: true, target: KIM });
  assert.equal((await first).ok, true);
});

test('the hub is told what this account already found or has on the way, and only this account', async () => {
  const { world } = seeded({ earned: 30_000, purchases: [PROBE(ME, { x: 1, y: 2 }), PROBE({ x: 99, y: 99 }, { x: 3, y: 4 }), PROBE(ME, { x: 5, y: 6 }, { earnedAt: 1e9 })] });
  const find = finder();
  await world.probe({ ang: 0, me: ME, find });
  assert.deepEqual(find.asked[0].skip, [{ x: 1, y: 2 }, { x: 5, y: 6 }]);
});

test('in-flight purchases keep their thresholds', async () => {
  // Bought before the switch, with nothing stored but the price: 3,000 more credit to arrive, or to light.
  const oldProbe = PROBE(ME, { x: 1, y: 2 }, { earnedAt: 10_000 }), oldPush = { kind: 'frontier', at: at(0), price: 4000, earnedAt: 10_000, ang: 0 };
  const { world, file, reload } = seeded({ earned: 10_000, purchases: [oldProbe, oldPush] });
  assert.equal((await world.probe({ ang: 1, me: ME, find: finder() })).ok, true);
  assert.equal(world.buy({ kind: 'frontier', ang: 2 }).ok, true); // far enough from the old push to be a lobe of its own
  const look = () => { const s = reload().summary(); return { probes: s.probes.map((q) => q.arrived), lit: s.frontier.map((l) => l.lit) }; };
  earn(file, 500);
  assert.deepEqual(look().probes, [false, true], 'the new probe is there after 500');
  earn(file, 100);
  assert.deepEqual(look().lit[1], PUSH_LEN, 'the new push is lit after 600');
  assert.ok(look().lit[0] < PUSH_LEN);
  earn(file, 2399);
  assert.deepEqual(look().probes, [false, true], 'the old probe still needs 3,000');
  earn(file, 1);
  assert.deepEqual(look(), { probes: [true, true], lit: [PUSH_LEN, PUSH_LEN] });
});

test('a probe arrives after 500 more credit', async () => {
  const { world, file, reload } = seeded();
  await world.probe({ ang: 0, me: ME, find: finder() });
  const [q] = world.summary().probes;
  assert.deepEqual([q.id, q.progress, q.arrived, q.by, q.to], ['q0', 0, false, ME, { x: 120, y: -40 }]);
  earn(file, PROBE_TRAVEL / 2);
  await reload().scan({ git: false });
  assert.equal(reload().summary().probes[0].progress, 0.5);
  earn(file, PROBE_TRAVEL / 2);
  await reload().scan({ git: false });
  assert.deepEqual([reload().summary().probes[0].progress, reload().summary().probes[0].arrived], [1, true]);
});

test("the projection carries only this account's probes, and a target only once it arrived", () => {
  const purchases = [PROBE(ME, { x: 1, y: 2 }), PROBE({ x: 99, y: 99 }, { x: 3, y: 4 }), PROBE(ME, { x: 5, y: 6 }, { ang: 2, earnedAt: 1e9 })];
  const s = seeded({ purchases, earned: 20_000 }).world.summary();
  assert.deepEqual(publicProjection(s, ME).probes, [{ ang: 0, progress: 1, to: { x: 1, y: 2 } }, { ang: 2, progress: 0 }]);
  assert.deepEqual(publicProjection(s, { x: 99, y: 99 }).probes, [{ ang: 0, progress: 1, to: { x: 3, y: 4 } }]);
  assert.deepEqual(publicProjection(s, null).probes, []);
  assert.deepEqual(publicProjection(s).probes, []);
  assert.deepEqual(validProjection(publicProjection(s, ME)), publicProjection(s, ME), 'and it validates as it is');
});
