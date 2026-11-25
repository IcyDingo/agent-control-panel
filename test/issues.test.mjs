// issues: the list of work in the Issues panel, kept per workspace. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIssues } from '../issues.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glue-issues-')), 'issues.json');
const mk = () => { const file = tmp(); return { file, s: createIssues({ file }) }; };
const ids = (list) => list.map((x) => x.id);

test('an issue has a one-line title of 120 characters at most, and is kept per workspace', () => {
  const { s } = mk();
  const a = s.create('w1', '  Checkout on\nthe v2 API  ');
  assert.equal(a.ok, true);
  assert.deepEqual(s.list('w1').map((x) => x.title), ['Checkout on the v2 API']);
  assert.equal(s.create('w1', '   ').ok, false, 'a title is needed');
  assert.equal(s.create('w1', 'x'.repeat(121)).ok, false);
  assert.deepEqual(s.list('w2'), [], 'another workspace sees nothing of it');
  assert.equal(s.rename('w2', a.id, 'Hijack').ok, false);
  assert.equal(s.rename('w1', a.id, 'Checkout, v2').ok, true);
  assert.equal(s.list('w1')[0].title, 'Checkout, v2');
  const issue = s.list('w1')[0];
  assert.deepEqual({ space: issue.space, owns: issue.owns, folder: issue.folder, choices: issue.choices, items: issue.items }, { space: null, owns: false, folder: null, choices: null, items: [] });
  s.list('w1')[0].title = 'changed outside'; // a copy
  assert.equal(s.list('w1')[0].title, 'Checkout, v2');
  assert.equal(s.remove('w1', a.id).ok, true);
  assert.deepEqual(s.list('w1'), []);
});

test('items: one line of 300 characters at most, added, edited and removed', () => {
  const { s } = mk();
  const { id } = s.create('w', 'Checkout');
  const a = s.addItem('w', id, 'Cart endpoint'), b = s.addItem('w', id, 'Cart\npage');
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(s.list('w')[0].items.map((x) => [x.text, x.state]), [['Cart endpoint', 'todo'], ['Cart page', 'todo']]);
  assert.equal(s.addItem('w', id, 'x'.repeat(301)).ok, false);
  assert.equal(s.addItem('w', 'nope', 'x').ok, false);
  assert.equal(s.editItem('w', id, a.id, 'Cart API').ok, true);
  assert.equal(s.removeItem('w', id, b.id).ok, true);
  assert.deepEqual(s.list('w')[0].items.map((x) => x.text), ['Cart API']);
});

test('move: an item within its issue, an issue among issues; onto itself or an unknown id changes nothing', () => {
  const { s } = mk();
  const i1 = s.create('w', 'One').id, i2 = s.create('w', 'Two').id, i3 = s.create('w', 'Three').id;
  const a = s.addItem('w', i1, 'a').id, b = s.addItem('w', i1, 'b').id, c = s.addItem('w', i1, 'c').id;
  assert.equal(s.move('w', { issue: i1, item: c, before: a }).ok, true);
  assert.deepEqual(s.list('w')[0].items.map((x) => x.text), ['c', 'a', 'b']);
  assert.equal(s.move('w', { issue: i1, item: c }).ok, true, 'no `before`: to the end');
  assert.deepEqual(s.list('w')[0].items.map((x) => x.text), ['a', 'b', 'c']);
  assert.equal(s.move('w', { issue: i1, item: b, before: b }).ok, true);
  assert.deepEqual(s.list('w')[0].items.map((x) => x.text), ['a', 'b', 'c'], 'onto itself: nothing changes');
  assert.equal(s.move('w', { issue: i1, item: 'nope', before: a }).ok, false);
  assert.equal(s.move('w', { issue: i1, item: a, before: 'nope' }).ok, false);
  assert.equal(s.move('w', { issue: i3, before: i1 }).ok, true);
  assert.deepEqual(ids(s.list('w')), [i3, i1, i2]);
  assert.equal(s.move('w', { issue: i3 }).ok, true);
  assert.deepEqual(ids(s.list('w')), [i1, i2, i3]);
  assert.equal(s.list('w')[0].items.length, 3, 'nothing lost');
});

test('an item is ticked done and back; started by a launch, claimed by its session, its branches kept once, done by a merge', () => {
  const { s } = mk();
  const issue = s.create('w', 'Checkout').id, item = s.addItem('w', issue, 'Cart page').id;
  const at = () => s.list('w')[0].items[0];
  assert.equal(s.tick('w', issue, item, true).ok, true);
  assert.deepEqual([at().state, at().doneBy], ['done', 'tick']);
  s.tick('w', issue, item, false);
  assert.deepEqual([at().state, at().doneBy], ['todo', null]);
  assert.equal(s.startItem('w', issue, item, 'b0000007').ok, true);
  assert.deepEqual([at().state, at().launchId, at().sessionId], ['working', 'b0000007', null]);
  assert.deepEqual(s.claimItem('w', 'b0000007', 'sid-1'), { ws: 'w', issue, item });
  assert.equal(at().sessionId, 'sid-1');
  assert.equal(s.claimItem('w', 'b0000007', 'sid-2'), null, 'claimed once');
  s.addBranch('w', issue, item, 'feat-x'); s.addBranch('w', issue, item, 'feat-x'); s.addBranch('w', issue, item, 'feat-y');
  assert.deepEqual(at().branches, ['feat-x', 'feat-y']);
  assert.deepEqual(s.openItems().map((x) => [x.ws, x.item, x.branches]), [['w', item, ['feat-x', 'feat-y']]]);
  assert.equal(s.done('w', issue, item, 91).ok, true);
  assert.deepEqual([at().state, at().doneBy, at().pr], ['done', 'merge', 91]);
  assert.deepEqual(s.openItems(), [], 'a done item is followed no more');
  s.tick('w', issue, item, false);
  s.startItem('w', issue, item, 'b0000008');
  assert.equal(s.back('w', issue, item).ok, true);
  assert.deepEqual([at().state, at().sessionId, at().launchId, at().branches], ['todo', null, null, []]);
});

test('an issue keeps its space (and whether it made it), its folder and its launch choices; a space that goes unlinks it', () => {
  const { s } = mk();
  const a = s.create('w', 'Checkout').id, b = s.create('w', 'Billing').id;
  s.setSpace('w', a, 'sp1', true);
  s.setSpace('w', b, 'sp1', false);
  s.setLaunch('w', a, { folder: '/code/shop', choices: { model: 'sonnet', login: 'default', agentKind: 'claude', bogus: 'x' } });
  const got = s.list('w')[0];
  assert.deepEqual([got.space, got.owns, got.folder, got.choices], ['sp1', true, '/code/shop', { model: 'sonnet', login: 'default', agentKind: 'claude' }]);
  assert.equal(s.setLaunch('w', a, { folder: 'relative/path' }).ok, false, 'a folder is an absolute path');
  s.unlinkSpace('w', 'sp1');
  assert.deepEqual(s.list('w').map((x) => [x.space, x.owns]), [[null, false], [null, false]]);
});

test('it survives a restart; a malformed file keeps what is valid', () => {
  const { file, s } = mk();
  const i = s.create('w', 'Checkout').id;
  s.addItem('w', i, 'Cart page');
  assert.deepEqual(createIssues({ file }).list('w').map((x) => [x.title, x.items.map((y) => y.text)]), [['Checkout', ['Cart page']]]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, JSON.stringify({ v: 1, ws: { w: [{ id: 'aaaaaaaa', title: 'Good', items: [{ id: 'bbbbbbbb', text: 'ok', state: 'working', at: 1 }, { text: 'no id' }] }, { title: 'no id' }, 7], x: 'nope' } }));
  const t = createIssues({ file }).list('w');
  assert.deepEqual(t.map((x) => [x.title, x.items.map((y) => [y.text, y.state])]), [['Good', [['ok', 'working']]]]);
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(createIssues({ file }).list('w'), []);
});
