// Paste a goal: how pasted text becomes one goal and its parts (HomeBoard.pastedGoal), and back (pastedText).
// public/home-board.js is a plain script the page loads; here it is imported and read from globalThis. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../public/home-board.js');
const { pastedGoal, pastedText } = globalThis.HomeBoard;

test('the first line is the goal, every line under it a part, nested or not', () => {
  assert.deepEqual(pastedGoal('# **Faster pages**:\n- cache images\n    - lazy load\n\nship it\n1. measure\n2) [x] tell the team\n## Later\n* `cdn`'), {
    title: 'Faster pages', items: ['cache images', 'lazy load', 'ship it', 'measure', 'tell the team', 'Later', 'cdn'] });
  assert.deepEqual(pastedGoal('\n\n  Launch the beta  \n\twrite the invite email\r\nfix the signup bug\n'), { title: 'Launch the beta', items: ['write the invite email', 'fix the signup bug'] });
  assert.deepEqual(pastedGoal('- one\n- two'), { title: 'one', items: ['two'] });
  assert.deepEqual(pastedGoal('Just one line'), { title: 'Just one line', items: [] });
});

test('no words, no goal', () => {
  assert.equal(pastedGoal(''), null);
  assert.equal(pastedGoal('  \n\n -  \n# \n'), null);
  assert.equal(pastedGoal(null), null);
});

test('lines are cut to what a goal and a part hold, 50 parts at most', () => {
  const g = pastedGoal(`${'t'.repeat(200)}\n- ${'p'.repeat(400)}`);
  assert.equal(g.title.length, 120);
  assert.ok(g.title.endsWith('…'));
  assert.equal(g.items[0].length, 300);
  assert.equal(pastedGoal(['goal', ...Array.from({ length: 60 }, (_, i) => `- p${i}`)].join('\n')).items.length, 50);
});

test('pastedText writes a goal back so pastedGoal reads it the same', () => {
  const g = { title: 'Faster pages', items: ['cache images', 'lazy load'] };
  assert.equal(pastedText(g), 'Faster pages\n- cache images\n- lazy load');
  assert.deepEqual(pastedGoal(pastedText(g)), g);
  assert.deepEqual(pastedGoal(pastedText({ title: 'Alone', items: [] })), { title: 'Alone', items: [] });
  assert.equal(pastedText(null), '');
});
