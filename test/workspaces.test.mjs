// The store of workspaces and where repositories belong. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COLORS, repoKey, createStore, countOnly } from '../workspaces.mjs';

const PROFILES = [{ id: 'default', dir: '/h/.claude', plain: true }, { id: 'contract', dir: '/h/.claude-contract', plain: false }];
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glue-ws-')), 'workspaces.json');

test('defaults come from the profiles', () => {
  const s = createStore({ file: tmp(), profiles: [{ id: 'default', plain: true }, { id: 'contract', plain: false }] });
  assert.deepEqual(s.list().map((w) => [w.id, w.name, w.color]), [['contract', 'claude-contract', 'blue'], ['default', 'claude', 'violet']]);
  assert.deepEqual(s.list().map((w) => w.order), [0, 1]);
  const named = createStore({ file: tmp(), profiles: PROFILES });
  assert.deepEqual(named.list().map((w) => w.name), ['claude-contract', 'claude']);
  assert.equal(COLORS.violet, '#a98af0');
  assert.equal(COLORS.blue, '#7ea6e6');
  assert.equal(COLORS.amber, undefined);
});

test('a missing, empty or corrupt file gives the defaults', () => {
  for (const body of [undefined, '', '{nope']) {
    const file = tmp();
    if (body !== undefined) fs.writeFileSync(file, body);
    const s = createStore({ file, profiles: PROFILES });
    assert.equal(s.list().length, 2);
    assert.equal(s.get('default').name, 'claude');
  }
});

test('update renames and recolours, refusing a duplicate or empty name', () => {
  const s = createStore({ file: tmp(), profiles: PROFILES });
  assert.deepEqual(s.update('contract', { name: 'Work' }), { ok: true });
  assert.equal(s.get('contract').name, 'Work');
  assert.equal(s.update('default', { name: 'work' }).ok, false);
  assert.equal(s.update('default', { name: '  ' }).ok, false);
  assert.equal(s.update('default', { name: 'x'.repeat(25) }).ok, false);
  assert.equal(s.update('default', { color: 'amber' }).ok, false);
  assert.equal(s.update('nope', { name: 'Y' }).ok, false);
  assert.deepEqual(s.update('contract', { name: 'WORK' }), { ok: true });
  assert.deepEqual(s.update('default', { name: 'Private', color: 'rose' }), { ok: true });
  assert.deepEqual(s.get('default'), { id: 'default', name: 'Private', color: 'rose' });
  assert.equal(s.get('nope'), null);
});

test('a repository can be in one, several or no workspaces', () => {
  const s = createStore({ file: tmp(), profiles: PROFILES });
  assert.deepEqual(s.reposOf('gh:o/n'), []);
  assert.deepEqual(s.assign('gh:o/n', ['contract']), { ok: true });
  assert.deepEqual(s.reposOf('gh:o/n'), ['contract']);
  assert.deepEqual(s.assign('gh:o/n', ['contract', 'default']), { ok: true });
  assert.deepEqual(s.reposOf('gh:o/n'), ['contract', 'default']);
  assert.deepEqual(s.assigned(), [{ key: 'gh:o/n', ws: ['contract', 'default'] }]);
  assert.deepEqual(s.assign('gh:o/n', []), { ok: true });
  assert.deepEqual(s.reposOf('gh:o/n'), []);
  assert.deepEqual(s.assigned(), []);
  assert.equal(s.assign('gh:o/n', ['nope']).ok, false);
  assert.deepEqual(s.reposOf('gh:o/n'), []);
});

test('repoKey prefers the GitHub slug', () => {
  assert.equal(repoKey({ slug: 'o/n', common: '/x/.git' }), 'gh:o/n');
  assert.equal(repoKey({ common: '/x/.git' }), 'git:/x/.git');
  assert.equal(repoKey({ dir: '/x' }), 'dir:/x');
});

test('it persists privately', () => {
  const file = tmp();
  const s = createStore({ file, profiles: PROFILES });
  s.update('contract', { name: 'Work', color: 'teal' });
  s.assign('gh:o/n', ['contract']);
  s.setFocus('contract');
  const again = createStore({ file, profiles: PROFILES });
  assert.deepEqual(again.get('contract'), { id: 'contract', name: 'Work', color: 'teal' });
  assert.deepEqual(again.reposOf('gh:o/n'), ['contract']);
  assert.equal(again.focus(), 'contract');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['workspaces.json']);
});

test('sync adds a new profile without touching the rest', () => {
  const s = createStore({ file: tmp(), profiles: PROFILES });
  s.update('contract', { name: 'Work' });
  s.sync([...PROFILES, { id: 'x', dir: '/h/.claude-x', plain: false }]);
  assert.equal(s.get('contract').name, 'Work');
  assert.deepEqual(s.get('x'), { id: 'x', name: 'claude-x', color: 'green' });
  assert.deepEqual(s.list().map((w) => w.id), ['contract', 'x', 'default']);
});

test('names that live on every object are unknown, not found: ids, repository keys and colours', () => {
  const s = createStore({ file: tmp(), profiles: PROFILES });
  const before = JSON.stringify([s.list(), s.assigned()]);
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(s.get(bad), null, bad);
    assert.equal(s.update(bad, { name: 'x' }).ok, false, bad);
    assert.equal(s.update('default', { color: bad }).ok, false, bad);
    assert.equal(s.assign('k', [bad]).ok, false, bad);
    assert.deepEqual(s.reposOf(bad), [], bad);
    s.setFocus(bad);
    assert.equal(s.focus(), 'contract', bad);
    // As repository keys, which are free text, they work like any other.
    assert.deepEqual(s.assign(bad, ['default']), { ok: true }, bad);
    assert.deepEqual(s.reposOf(bad), ['default'], bad);
    assert.deepEqual(s.assign(bad, []), { ok: true }, bad);
  }
  assert.equal(s.update('default', { name: 42 }).ok, false);
  assert.equal(JSON.stringify([s.list(), s.assigned()]), before);
});

test('a file with such names in it is loaded without them taking hold', () => {
  const file = tmp();
  fs.writeFileSync(file, '{"v":1,"workspaces":{"default":{"name":"Private","color":"constructor"},"contract":{"name":"Work","color":"teal"},'
    + '"__proto__":{"name":"Z","color":"toString"}},"order":["__proto__","constructor","contract"],'
    + '"repos":{"k":["constructor","__proto__","contract"],"__proto__":["constructor"],"constructor":["contract"]},"focus":"__proto__"}');
  const s = createStore({ file, profiles: PROFILES });
  // A colour that is not one drops that workspace back to its profile's defaults; unknown ids are dropped everywhere.
  assert.deepEqual(s.list().map((w) => [w.id, w.name, w.color]), [['contract', 'Work', 'teal'], ['default', 'claude', 'violet']]);
  assert.deepEqual(s.reposOf('k'), ['contract']);
  assert.deepEqual(s.reposOf('constructor'), ['contract']);
  assert.deepEqual(s.reposOf('__proto__'), []);
  assert.equal(s.get('__proto__'), null);
  assert.equal(s.focus(), 'contract');
});

test('a notification about a workspace out of focus is its name and a count, nothing else', () => {
  assert.deepEqual(countOnly('Work'), { title: 'Glue', text: 'Work: a check failed' });
  assert.deepEqual(countOnly('Work', { waits: true }), { title: 'Glue', text: 'Work: 1 needs you' });
  assert.deepEqual(countOnly('Private', { waits: false }), { title: 'Glue', text: 'Private: a check failed' });
  // The count is how many things wait there, not always one.
  assert.deepEqual(countOnly('Work', { waits: true, n: 3 }), { title: 'Glue', text: 'Work: 3 needs you' });
  assert.deepEqual(countOnly('Work', { waits: true, n: 0 }), { title: 'Glue', text: 'Work: 1 needs you' }, 'never fewer than the one being told of');
  assert.deepEqual(countOnly('Work', { waits: true, n: 'x' }), { title: 'Glue', text: 'Work: 1 needs you' });
});

test('reorder takes a permutation of the workspace ids and keeps it', () => {
  const file = tmp();
  const s = createStore({ file, profiles: PROFILES });
  assert.deepEqual(s.list().map((w) => w.id), ['contract', 'default']);
  assert.equal(s.reorder(['default']).ok, false);
  assert.equal(s.reorder(['default', 'x']).ok, false);
  assert.equal(s.reorder(['default', 'default']).ok, false);
  assert.equal(s.reorder(['default', 'contract', 'x']).ok, false);
  assert.equal(s.reorder(['__proto__', 'constructor']).ok, false);
  assert.equal(s.reorder('default,contract').ok, false);
  assert.deepEqual(s.list().map((w) => w.id), ['contract', 'default']);
  assert.equal(s.reorder(['default', 'contract']).ok, true);
  assert.deepEqual(s.list().map((w) => [w.id, w.order]), [['default', 0], ['contract', 1]]);
  assert.deepEqual(createStore({ file, profiles: PROFILES }).list().map((w) => w.id), ['default', 'contract']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// Spaces: named groups of sessions inside one workspace, for what they work on.
const SID = 'aaaaaaaa-1111-4111-8111-111111111111';
const DAY = 86_400_000;

test('spaces are made, renamed and deleted per workspace', () => {
  const s = createStore({ file: tmp(), profiles: PROFILES });
  const r = s.createSpace('default', 'Checkout redesign');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(s.spacesOf('default'), [{ id: r.id, name: 'Checkout redesign' }]);
  assert.deepEqual(s.spacesOf('contract'), []);
  assert.equal(s.renameSpace('default', r.id, 'Checkout').ok, true);
  assert.deepEqual(s.spacesOf('default').map((x) => x.name), ['Checkout']);
  assert.equal(s.deleteSpace('default', r.id).ok, true);
  assert.deepEqual(s.spacesOf('default'), []);
});

test('a space name is checked', () => {
  const s = createStore({ file: tmp(), profiles: PROFILES });
  assert.equal(s.createSpace('default', '   ').error, 'A space needs a name.');
  assert.equal(s.createSpace('default', 'a'.repeat(41)).error, 'A name is at most 40 characters.');
  const b = s.createSpace('default', 'Billing');
  assert.equal(b.ok, true);
  assert.equal(s.createSpace('default', 'billing').error, 'Another space has that name.');
  assert.equal(s.renameSpace('default', b.id, 'BILLING').ok, true);
  assert.equal(s.createSpace('contract', 'Billing').ok, true);
  assert.equal(s.createSpace('nope', 'x').error, 'No such workspace.');
  assert.equal(s.renameSpace('default', 'nope', 'x').error, 'No such space.');
  assert.equal(s.deleteSpace('default', 'nope').error, 'No such space.');
});

test('sessions are put in a space and taken out', () => {
  const s = createStore({ file: tmp(), profiles: PROFILES });
  const { id } = s.createSpace('default', 'Billing');
  assert.equal(s.setSpace('default', SID, id).ok, true);
  assert.equal(s.spaceOf('default', SID), id);
  assert.equal(s.spaceOf('contract', SID), null);
  assert.equal(s.setSpace('default', SID, null).ok, true);
  assert.equal(s.spaceOf('default', SID), null);
  assert.equal(s.setSpace('default', SID, 'nope').error, 'No such space.');
  assert.equal(s.setSpace('contract', SID, id).error, 'No such space.', 'another workspace\'s space');
  s.setSpace('default', SID, id);
  s.deleteSpace('default', id);
  assert.equal(s.spaceOf('default', SID), null);
});

test('spaces survive a restart, and a malformed spaces part is ignored', () => {
  const file = tmp();
  const s = createStore({ file, profiles: PROFILES });
  const { id } = s.createSpace('default', 'Billing');
  s.setSpace('default', SID, id);
  const again = createStore({ file, profiles: PROFILES });
  assert.deepEqual(again.spacesOf('default'), [{ id, name: 'Billing' }]);
  assert.equal(again.spaceOf('default', SID), id);
  for (const spaces of ['nope', { default: { list: [{ id: 1 }] } }, { default: { list: 'x', members: { [SID]: { space: 'zz', at: 1 } } } }]) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bad = tmp();
    fs.writeFileSync(bad, JSON.stringify({ ...saved, spaces }));
    const t = createStore({ file: bad, profiles: PROFILES });
    assert.deepEqual(t.list().map((w) => w.id).sort(), ['contract', 'default']);
    assert.deepEqual(t.spacesOf('default'), []);
    assert.equal(t.spaceOf('default', SID), null);
  }
});

test('members not seen for 14 days are dropped', () => {
  const s = createStore({ file: tmp(), profiles: PROFILES });
  const { id } = s.createSpace('default', 'Billing');
  s.setSpace('default', SID, id);
  const t0 = Date.now() + DAY;
  s.touchSpaces('default', [SID], t0);
  s.touchSpaces('default', [], t0 + 13 * DAY);
  assert.equal(s.spaceOf('default', SID), id);
  s.touchSpaces('default', [], t0 + 15 * DAY);
  assert.equal(s.spaceOf('default', SID), null);
  assert.deepEqual(s.spacesOf('default').map((x) => x.id), [id], 'the space itself stays');
});
