// The hub's accounts: who signs in, which spot and handle they get, and what they may change about their profile.
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../hub/db.mjs';
import { createAccounts } from '../hub/accounts.mjs';
import { placeOf } from '../hub/coords.mjs';

const T = 1_700_000_000_000, WEEK = 7 * 24 * 3600 * 1000;
let db, accounts, clock;
const fresh = () => { clock = T; db = openDb(':memory:'); accounts = createAccounts(db, { now: () => clock }); };

test('the first sign-in creates an account at the next spiral spot; the second returns it', () => {
  fresh();
  const a = accounts.signIn({ provider: 'github', subject: '1', login: 'Alice', avatar: 'https://avatars.githubusercontent.com/u/1' });
  assert.equal(a.created, true);
  assert.deepEqual([a.account.ordinal, a.account.handle, { x: a.account.x, y: a.account.y }], [1, 'alice', placeOf(1)]);
  const again = accounts.signIn({ provider: 'github', subject: '1', login: 'alice-renamed' });
  assert.deepEqual([again.created, again.account.id, again.account.handle], [false, a.account.id, 'alice']);
});

test('a taken or invalid login gets a numbered handle; a foreign avatar is dropped', () => {
  fresh();
  accounts.signIn({ provider: 'github', subject: '1', login: 'alice' });
  const b = accounts.signIn({ provider: 'github', subject: '2', login: 'ALICE', avatar: 'https://evil.example/x.png' });
  assert.deepEqual([b.account.handle, b.account.avatar, b.account.ordinal], ['alice-2', null, 2]);
  assert.equal(accounts.signIn({ provider: 'dev', subject: 'x', login: '-bad-' }).account.handle, 'dev-3');
});

test('profile edits are validated; a handle changes once a week and never to a taken one', () => {
  fresh();
  const { account: a } = accounts.signIn({ provider: 'github', subject: '1', login: 'alice' });
  accounts.signIn({ provider: 'github', subject: '2', login: 'bob' });
  assert.equal(accounts.updateProfile(a.id, { bio: 'x'.repeat(161) }).status, 422);
  assert.equal(accounts.updateProfile(a.id, { link: 'ftp://x' }).status, 422);
  assert.deepEqual(accounts.updateProfile(a.id, { handle: 'bob' }), { ok: false, status: 409, error: 'That handle is taken.' });
  assert.equal(accounts.updateProfile(a.id, { handle: 'alice2', name: 'Alice', bio: 'hi', link: 'https://a.example' }).account.handle, 'alice2');
  assert.equal(accounts.updateProfile(a.id, { handle: 'alice3' }).error, 'A handle changes at most once a week.');
  assert.equal(accounts.byHandle('ALICE2').id, a.id);
  assert.equal(accounts.byHandle('alice'), null);
});

test('a handle may change again after a week; the same handle in other letters is not a change', () => {
  fresh();
  const { account: a } = accounts.signIn({ provider: 'github', subject: '1', login: 'alice' });
  assert.equal(accounts.updateProfile(a.id, { handle: 'alice2' }).ok, true);
  clock += WEEK - 1;
  assert.equal(accounts.updateProfile(a.id, { handle: 'alice3' }).status, 409);
  assert.equal(accounts.updateProfile(a.id, { handle: 'ALICE2' }).ok, true); // no-op, not a change
  clock += 1;
  assert.equal(accounts.updateProfile(a.id, { handle: 'alice3' }).account.handle, 'alice3');
});

test('visibility and the friends switch are stored; unknown keys are ignored; a bad value changes nothing', () => {
  fresh();
  const { account: a } = accounts.signIn({ provider: 'github', subject: '1', login: 'alice' });
  assert.deepEqual([a.visibility, a.showFriends, a.createdAt], ['public', true, T]);
  const r = accounts.updateProfile(a.id, { visibility: 'unlisted', showFriends: false, ordinal: 99, x: 5 });
  assert.deepEqual([r.account.visibility, r.account.showFriends, r.account.ordinal, r.account.x], ['unlisted', false, 1, a.x]);
  const bad = accounts.updateProfile(a.id, { name: 'Alice', visibility: 'secret' });
  assert.equal(bad.status, 422);
  assert.equal(accounts.byId(a.id).name, null);
  assert.equal(accounts.updateProfile(a.id, { handle: 'api' }).status, 422);
  assert.equal(accounts.updateProfile('nope', { name: 'x' }).ok, false);
});

test('an account is found by id, handle or exact spot, and lists its identities', () => {
  fresh();
  const { account: a } = accounts.signIn({ provider: 'github', subject: '1', login: 'alice' });
  assert.equal(accounts.byId(a.id).handle, 'alice');
  assert.equal(accounts.byId('nope'), null);
  assert.equal(accounts.byCoords(a.x, a.y).id, a.id);
  assert.equal(accounts.byCoords(a.x + 1, a.y), null);
  assert.deepEqual(accounts.identitiesOf(a.id), [{ provider: 'github', login: 'alice' }]);
});
