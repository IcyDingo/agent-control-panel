import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { releaseMessage, validN, verifyRelease, signRelease, rawPublicKey, publicKeyObject } from '../release-keys.mjs';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const pair = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { pub: rawPublicKey(publicKey), privateKey }; };

test('the message is "<n> <sha>" and n must be a positive integer', () => {
  assert.equal(releaseMessage(12, SHA), `12 ${SHA}`);
  for (const n of [1, 12, 2 ** 31]) assert.equal(validN(n), true, String(n));
  for (const n of [0, -1, 1.5, '7', NaN, Infinity, null, undefined, 2 ** 31 + 1]) assert.equal(validN(n), false, String(n));
});

test('a signature by a listed key verifies; one good among bad ones is enough, under any listed key', () => {
  const a = pair(), b = pair();
  const sigA = signRelease(12, SHA, a.privateKey), sigB = signRelease(12, SHA, b.privateKey);
  assert.equal(sigA.length, 86, 'base64url of 64 bytes, no padding');
  assert.equal(verifyRelease(12, SHA, [sigA], [a.pub]), true);
  assert.equal(verifyRelease(12, SHA, ['x'.repeat(86), sigB], [a.pub, b.pub]), true, 'a bad one first, a good one under the second key');
  assert.equal(verifyRelease(12, SHA, [sigA, sigB], [b.pub]), true, 'the key list need not know every signer');
});

test('a wrong key, sha, n, signature, or an empty list is refused and never throws', () => {
  const a = pair(), b = pair();
  const sig = signRelease(12, SHA, a.privateKey);
  assert.equal(verifyRelease(12, SHA, [sig], [b.pub]), false, 'wrong key');
  assert.equal(verifyRelease(12, OTHER, [sig], [a.pub]), false, 'wrong sha');
  assert.equal(verifyRelease(13, SHA, [sig], [a.pub]), false, 'the same sha with n+1');
  for (const n of [0, -1, 1.5, '12']) assert.equal(verifyRelease(n, SHA, [sig], [a.pub]), false, `n ${n}`);
  assert.equal(verifyRelease(12, SHA, [sig.slice(0, 40)], [a.pub]), false, 'truncated');
  assert.equal(verifyRelease(12, SHA, [sig.replace(/./g, '+')], [a.pub]), false, 'not base64url');
  assert.equal(verifyRelease(12, SHA, [], [a.pub]), false, 'no signatures');
  assert.equal(verifyRelease(12, SHA, Array(16).fill(sig), [a.pub]), true, 'sixteen signatures');
  assert.equal(verifyRelease(12, SHA, Array(17).fill(sig), [a.pub]), false, 'more than sixteen');
  assert.equal(verifyRelease(12, SHA, [sig], []), false, 'no keys');
  assert.equal(verifyRelease(12, SHA, sig, [a.pub]), false, 'sigs must be an array');
  assert.equal(verifyRelease(12, SHA, [sig], ['not a key']), false, 'a malformed key is skipped');
  assert.equal(verifyRelease(12, 'A'.repeat(40), [sig], [a.pub]), false, 'lower-case hex only');
});

test('a raw public key round-trips through a KeyObject', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = rawPublicKey(publicKey);
  assert.equal(Buffer.from(raw, 'base64').length, 32);
  assert.equal(rawPublicKey(publicKeyObject(raw)), raw);
  assert.equal(verifyRelease(1, SHA, [signRelease(1, SHA, privateKey)], [raw]), true);
});

test('the command line verifies with the keys in the file: exit 1 for an unknown key, nothing printed', () => {
  const a = pair(), b = pair();
  const sig = signRelease(12, SHA, a.privateKey);
  const run = (keysFile, ...args) => execFileSync('node', ['release-keys.mjs', 'verify', ...args], {
    stdio: 'pipe',
    env: { ...process.env, ACP_RELEASE_KEYS_FILE: keysFile },
  });
  // RELEASE_KEYS in the repo cannot hold a test key, so without a keys file the signature is refused.
  assert.throws(() => run('', SHA, '12', sig), (e) => e.status === 1 && e.stdout.length === 0);
  assert.throws(() => run('', SHA, 'x', sig), (e) => e.status === 1);

  // ACP_RELEASE_KEYS_FILE replaces the key list for the command line only.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-keys-'));
  try {
    const file = path.join(dir, 'keys.json');
    fs.writeFileSync(file, JSON.stringify([a.pub]));
    assert.equal(run(file, SHA, '12', sig).length, 0, 'a good signature exits 0 and prints nothing');
    assert.throws(() => run(file, SHA, '12', signRelease(12, SHA, b.privateKey)), (e) => e.status === 1 && e.stdout.length === 0);
    assert.equal(run(file, SHA, '12', `${signRelease(12, SHA, b.privateKey)},${sig}`).length, 0, 'several signatures are joined with a comma');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
