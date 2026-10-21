// World: what earns credit, and how the world remembers it. Run with `npm test`.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, multiplier, dayCredit, grown, commitKey, countsFile } from '../world.mjs';

test('multiplier rewards removing', () => {
  assert.equal(multiplier(0, 0), 1);
  assert.equal(multiplier(1000, 0), 1);
  assert.equal(multiplier(500, 500), 2.5);
  assert.equal(multiplier(0, 300), 4);
});

test('a day of work earns credit', () => {
  assert.equal(dayCredit({ added: 11000, removed: 0, tokens: 1_500_000 }), 1250);
  assert.equal(dayCredit({ added: 50, removed: 300, tokens: 0 }), Math.round(5 * 3.6));
});

test('day keys are calendar days', () => assert.equal(dayKey(Date.UTC(2026, 9, 21, 23, 59)), '2026-10-21'));

test('growth starts at nothing and never ends', () => {
  assert.equal(grown(0), 0);
  assert.ok(grown(30000) > 0.6 && grown(30000) < 0.64);
  assert.ok(grown(300_000) < 1); // about a year of work
});

test('a rebased or amended commit keeps its key', () => {
  assert.equal(commitKey(1792584000, 'fix: x'), commitKey(1792584000, 'fix: x'));
  assert.notEqual(commitKey(1792584000, 'fix: x'), commitKey(1792584001, 'fix: x'));
});

test('lockfiles do not count', () => {
  assert.equal(countsFile('a/package-lock.json'), false);
  assert.equal(countsFile('go.sum'), false);
  assert.equal(countsFile('src/a.js'), true);
});
