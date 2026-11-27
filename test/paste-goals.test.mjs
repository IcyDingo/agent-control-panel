// Paste goals: how pasted text splits into goals and their parts (HomeBoard.outlineOf), and back (outlineText).
// public/home-board.js is a plain script the page loads; here it is imported and read from globalThis. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../public/home-board.js');
const { outlineOf, outlineText } = globalThis.HomeBoard;

test('headings are goals, everything under them a part', () => {
  assert.deepEqual(outlineOf('# Faster pages\n- cache images\n  - lazy load\nship it\n\n## **Better login**:\n1. add Google\n2) [x] add GitHub'), [
    { title: 'Faster pages', items: ['cache images', 'lazy load', 'ship it'] },
    { title: 'Better login', items: ['add Google', 'add GitHub'] },
  ]);
});

test('without headings, the shallowest lines are goals and deeper ones parts', () => {
  assert.deepEqual(outlineOf('- Faster pages\n    - cache images\n\t- lazy load\n- Better login\n    - add Google'), [
    { title: 'Faster pages', items: ['cache images', 'lazy load'] },
    { title: 'Better login', items: ['add Google'] },
  ]);
});

test('all at one depth: plain lines are goals, bulleted lines parts', () => {
  assert.deepEqual(outlineOf('Faster pages:\n- cache images\n* lazy load\nBetter login\n• add Google'), [
    { title: 'Faster pages', items: ['cache images', 'lazy load'] },
    { title: 'Better login', items: ['add Google'] },
  ]);
});

test('blank-line blocks: each block is a goal and its other lines', () => {
  assert.deepEqual(outlineOf('Faster pages\ncache images\n\n\nBetter login\nadd Google\nadd GitHub\n'), [
    { title: 'Faster pages', items: ['cache images'] },
    { title: 'Better login', items: ['add Google', 'add GitHub'] },
  ]);
});

test('one flat list or prose: the first line is the goal, the rest its parts', () => {
  assert.deepEqual(outlineOf('Launch the beta\nwrite the invite email\nfix the signup bug'), [{ title: 'Launch the beta', items: ['write the invite email', 'fix the signup bug'] }]);
  assert.deepEqual(outlineOf('- one\n- two'), [{ title: 'one', items: ['two'] }]);
  assert.deepEqual(outlineOf('Just one line'), [{ title: 'Just one line', items: [] }]);
});

test('parts before the first heading become goals of their own; nothing in, nothing out', () => {
  assert.deepEqual(outlineOf('- stray\n# Goal\n- part'), [{ title: 'stray', items: [] }, { title: 'Goal', items: ['part'] }]);
  assert.deepEqual(outlineOf(''), []);
  assert.deepEqual(outlineOf('  \n\n -  \n'), []);
  assert.deepEqual(outlineOf(null), []);
});

test('lines are cut to what a goal and a part hold, and the counts are capped', () => {
  const [g] = outlineOf(`# ${'t'.repeat(200)}\n- ${'p'.repeat(400)}`);
  assert.equal(g.title.length, 120);
  assert.ok(g.title.endsWith('…'));
  assert.equal(g.items[0].length, 300);
  const many = Array.from({ length: 40 }, (_, i) => `# g${i}\n` + Array.from({ length: 60 }, (_, j) => `- p${j}`).join('\n')).join('\n');
  const out = outlineOf(many);
  assert.equal(out.length, 30);
  assert.equal(out[0].items.length, 50);
});

test('outlineText writes goals back so outlineOf reads them the same', () => {
  const goals = [{ title: 'Faster pages', items: ['cache images', 'lazy load'] }, { title: 'Better login', items: [] }];
  assert.equal(outlineText(goals), '# Faster pages\n- cache images\n- lazy load\n\n# Better login');
  assert.deepEqual(outlineOf(outlineText(goals)), goals);
  assert.equal(outlineText(null), '');
});
