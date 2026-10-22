// The hub's rate limits: token buckets per name and subject (an address or an account), refilled by the clock, pruned
// when the table grows. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimits, subjectOf, privatePeer, RATES } from '../hub/limits.mjs';

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

test('the table is pruned at 5,000 entries: full buckets go, a bucket still owed tokens stays', () => {
  const l = limits({ r: [2, MIN] });
  for (let i = 0; i < 4999; i++) l.take('r', `ip${i}`); // 4,999 buckets, each with one token left
  l.tick(MIN); // a whole window: all of them are full again
  l.take('r', 'busy'); l.take('r', 'busy'); // the 5,000th entry, emptied
  assert.equal(l.size(), 5000);
  l.take('r', 'new'); // the insert at 5,000 prunes first: the 4,999 full ones go, 'busy' stays
  assert.equal(l.size(), 2, 'busy and new remain');
  assert.equal(l.take('r', 'busy').ok, false, 'busy is still empty');
  assert.equal(l.take('r', 'ip7').ok, true, 'a pruned bucket is just a full one again');
  assert.equal(l.take('r', 'ip7').ok, true);
  assert.equal(l.take('r', 'ip7').ok, false);
});

test('a prune that finds nothing to drop does not run again until the table has doubled', () => {
  const l = limits({ r: [2, MIN] });
  for (let i = 0; i < 5000; i++) l.take('r', `ip${i}`); // 5,000 buckets, none full
  l.take('r', 'x'); // prunes at 5,000: nothing goes; the next prune waits for twice that, 10,000 entries
  assert.equal(l.size(), 5001);
  l.tick(MIN); // now every one of them is full
  l.take('r', 'y');
  assert.equal(l.size(), 5002, 'no prune at 5,001: the threshold rose');
  for (let i = 0; i < 4998; i++) l.take('r', `late${i}`);
  assert.equal(l.size(), 10000, 'still none');
  l.take('r', 'z'); // at 10,000 the prune runs: the 5,001 full ones go (y was spent after the tick), 4,999 stay, then z
  assert.equal(l.size(), 5000);
});

test('a clock that steps backwards does not drain a bucket', () => {
  const l = limits({ r: [2, MIN] }, 100_000);
  l.take('r', 'a');
  l.tick(-50_000);
  assert.equal(l.take('r', 'a').ok, true, 'the one token left is still there');
  assert.equal(l.take('r', 'a').ok, false, 'and no more');
});

test('subjectOf: IPv4 as it is, mapped IPv4 unwrapped, IPv6 cut to its /64, junk untouched', () => {
  assert.equal(subjectOf('1.2.3.4'), '1.2.3.4');
  assert.equal(subjectOf('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(subjectOf('2a01:4f8:1:2:ffff::1'), '2a01:4f8:1:2::/64');
  assert.equal(subjectOf('2a01:4f8:1:2::'), '2a01:4f8:1:2::/64');
  assert.equal(subjectOf('2A01:04F8:0001:0002:0:0:0:1'), '2a01:4f8:1:2::/64', 'case and leading zeros do not make a new visitor');
  assert.equal(subjectOf('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(subjectOf('::1'), '0:0:0:0::/64');
  assert.equal(subjectOf('garbage'), 'garbage');
  assert.equal(subjectOf(undefined), '');
});

test('privatePeer: loopback and the private ranges, nothing else', () => {
  for (const a of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.5', 'fd12::1', 'fc00::1']) assert.equal(privatePeer(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '2a01:4f8::1', 'fe80::1', '', undefined, '192.169.0.1']) assert.equal(privatePeer(a), false, String(a));
});
