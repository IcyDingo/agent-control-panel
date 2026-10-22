// The hub's rate limits: token buckets per name and subject (an address or an account), refilled by the clock, pruned
// when the table grows. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimits, RATES } from '../hub/limits.mjs';

const MIN = 60_000;
const limits = (rates, start = 0) => {
  let clock = start;
  const l = createLimits({ now: () => clock, rates });
  return { ...l, tick: (ms) => { clock += ms; } };
};

test('every named rate is a count and a window in milliseconds', () => {
  for (const [name, rate] of Object.entries(RATES)) {
    assert.ok(Array.isArray(rate) && rate.length === 2, name);
    assert.ok(Number.isInteger(rate[0]) && rate[0] >= 1, `${name}: a whole number of calls`);
    assert.ok(rate[1] >= 1000, `${name}: a window of at least a second`);
  }
  assert.deepEqual(RATES.device_code, [5, MIN]);
  assert.deepEqual(RATES.system, [12, MIN]);
});

test('n calls pass, the next is refused with a wait of at least a second, and the window refills the bucket', () => {
  const l = limits({ small: [3, MIN] });
  for (let i = 0; i < 3; i++) assert.deepEqual(l.take('small', 'a'), { ok: true }, `call ${i + 1}`);
  const no = l.take('small', 'a');
  assert.equal(no.ok, false);
  assert.ok(Number.isInteger(no.retryAfter) && no.retryAfter >= 1, `retryAfter ${no.retryAfter}`);
  assert.ok(no.retryAfter <= 20, 'one token comes back after a third of the window');
  l.tick(no.retryAfter * 1000);
  assert.deepEqual(l.take('small', 'a'), { ok: true }, 'the wait it named is enough');
  assert.equal(l.take('small', 'a').ok, false, 'but only one token came back');
  l.tick(MIN);
  for (let i = 0; i < 3; i++) assert.deepEqual(l.take('small', 'a'), { ok: true }, 'full again after the window');
});

test('subjects and names are independent of each other', () => {
  const l = limits({ one: [1, MIN], two: [1, MIN] });
  assert.equal(l.take('one', 'a').ok, true);
  assert.equal(l.take('one', 'a').ok, false);
  assert.equal(l.take('one', 'b').ok, true, 'another subject has its own bucket');
  assert.equal(l.take('two', 'a').ok, true, 'another name has its own bucket');
});

test('an unknown name is a programming error, not a pass', () => {
  const l = limits({ one: [1, MIN] });
  assert.throws(() => l.take('nope', 'a'), /unknown limit/);
});

test('refill is continuous: half the window gives back half the tokens', () => {
  const l = limits({ r: [10, MIN] });
  for (let i = 0; i < 10; i++) l.take('r', 'a');
  assert.equal(l.take('r', 'a').ok, false);
  l.tick(MIN / 2);
  let passed = 0;
  while (l.take('r', 'a').ok) passed++;
  assert.equal(passed, 5);
});

test('the table is pruned past 5,000 entries: full buckets go, buckets still owed tokens stay', () => {
  const l = limits({ r: [2, MIN] });
  for (let i = 0; i < 5000; i++) l.take('r', `ip${i}`); // 5,000 buckets, each with one token left
  l.take('r', 'busy'); l.take('r', 'busy'); // one empty bucket
  assert.equal(l.size(), 5001);
  l.tick(MIN); // a whole window: every bucket is full again, the empty one included
  l.take('r', 'new'); // the 5,002nd entry triggers a prune: the 5,001 full ones go, 'new' stays
  assert.equal(l.size(), 1);
  assert.equal(l.take('r', 'new').ok, true, 'a pruned bucket is just a full one again');
  assert.equal(l.take('r', 'new').ok, false);
});

test('pruning keeps a bucket that is still owed tokens', () => {
  const l = limits({ r: [2, MIN] });
  for (let i = 0; i < 5000; i++) l.take('r', `ip${i}`);
  l.take('r', 'busy'); l.take('r', 'busy');
  l.tick(MIN / 2); // the 5,000 are full again (one token owed, half a window gives one), 'busy' is at one of two
  l.take('r', 'new');
  assert.equal(l.size(), 2, 'busy and new remain');
  assert.equal(l.take('r', 'busy').ok, true, 'busy still had its one token');
  assert.equal(l.take('r', 'busy').ok, false);
});
