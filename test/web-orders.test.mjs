// What the hub's website may make this Mac do: the switch, the known kinds and the daily cap on builds, all kept in a
// file on the Mac; and `node server.mjs orders [on|off]`, run against a temp prefs folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { KINDS, BUILDS_PER_DAY, readPolicy, setOn, admit, takeBuild, describe } from '../web-orders.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'web-orders-'));
const fileIn = (dir) => path.join(dir, 'web-orders.json');
const NOON = new Date(2026, 9, 23, 12, 0).getTime(), NEXT_DAY = new Date(2026, 9, 24, 0, 5).getTime();

test('no file, or a broken one, reads as on with 10 builds a day', () => {
  const file = fileIn(tmp());
  assert.deepEqual(readPolicy(file), { on: true, buildsPerDay: BUILDS_PER_DAY, day: null, builds: 0 });
  for (const text of ['nope', '[]', 'null', '{"on":"no","buildsPerDay":-1,"builds":1.5}', '{"buildsPerDay":1000}']) {
    fs.writeFileSync(file, text);
    const p = readPolicy(file);
    assert.equal(p.buildsPerDay, BUILDS_PER_DAY, text);
    assert.equal(p.on, true, `${text}: only a plain false turns orders off`);
  }
});

test('the four kinds the game knows run; anything else, or everything once turned off, is refused', () => {
  const file = fileIn(tmp());
  for (const kind of KINDS) assert.equal(admit(file, { kind }), null, kind);
  assert.deepEqual(KINDS, ['frontier', 'rocket', 'build', 'probe']);
  for (const order of [{ kind: 'shell' }, { kind: 'agent' }, {}, null]) assert.equal(admit(file, order), "This Mac doesn't know that kind of order.");
  setOn(file, false);
  for (const kind of KINDS) assert.match(admit(file, { kind }), /^This Mac doesn't take orders from the website\. To allow them, run {2}node server\.mjs orders on {2}on the Mac\.$/);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600, 'only the Mac user can change it');
  setOn(file, true);
  assert.equal(admit(file, { kind: 'build' }), null);
});

test('builds are counted per local day, up to the cap, and the count starts again the next day', () => {
  const file = fileIn(tmp());
  fs.writeFileSync(file, JSON.stringify({ buildsPerDay: 3 }));
  for (let i = 0; i < 3; i++) assert.equal(takeBuild(file, NOON), null, `build ${i + 1}`);
  assert.equal(takeBuild(file, NOON), "This Mac runs at most 3 builds a day from the website, and today's are used. Build from the Mac's own panel, or again tomorrow.");
  assert.equal(describe(file, NOON), 'Website orders: on (3 of 3 builds used today).');
  assert.equal(takeBuild(file, NEXT_DAY), null, 'a new day');
  assert.equal(describe(file, NEXT_DAY), 'Website orders: on (1 of 3 builds used today).');
  setOn(file, false);
  assert.equal(readPolicy(file).buildsPerDay, 3, 'turning orders off keeps the cap');
  fs.writeFileSync(file, JSON.stringify({ buildsPerDay: 0 }));
  assert.match(takeBuild(file, NOON), /at most 0 builds a day/, 'a cap of 0 allows no website builds');
});

test('node server.mjs orders shows the switch, and orders off / on change it', () => {
  const dir = tmp();
  const cli = (...args) => execFileSync(process.execPath, ['server.mjs', ...args], {
    env: { ...process.env, ACP_PREFS: path.join(dir, 'prefs.json') }, encoding: 'utf8' }).trim();
  assert.equal(cli('orders'), 'Website orders: on (0 of 10 builds used today).');
  assert.equal(cli('orders', 'off'), 'Website orders: off. Builds, rockets, pushes and probes ordered on the website are refused on this Mac.');
  assert.equal(readPolicy(fileIn(dir)).on, false);
  assert.equal(cli('orders', 'on'), 'Website orders: on (0 of 10 builds used today).');
  assert.throws(() => cli('orders', 'maybe'), /usage: /);
});
