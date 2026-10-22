// The public keys every hub and worker trusts, and the one way a release is signed and checked. A release is the number
// `n` and the commit `sha`; the owner signs the text "<n> <sha>" with an Ed25519 key, and anyone holding the matching
// public key below can tell the release is the owner's. The hub, the deploy script and the worker all import this file,
// so they cannot disagree about what a signature covers.
// Nothing here that checks a signature throws: a release that cannot be checked is simply not accepted.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// The raw 32-byte Ed25519 public keys of the people who may sign a release, each as standard base64. The owner pastes
// the first one after running `keygen`, one line per key with the date it was added, like this:
//   'base64…', // added 2026-10-22
export const RELEASE_KEYS = [];

export const SHA_RE = /^[0-9a-f]{40}$/;

// What comes before a raw Ed25519 public key in its SPKI DER form.
const PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

export function releaseMessage(n, sha) {
  return `${n} ${sha}`;
}

export function validN(n) {
  return Number.isInteger(n) && n >= 1 && n <= 2 ** 31;
}

export function signRelease(n, sha, privateKey) {
  return crypto.sign(null, Buffer.from(releaseMessage(n, sha)), privateKey).toString('base64url');
}

export function rawPublicKey(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

export function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([PREFIX, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });
}

// True when any of the signatures (at most 16 are looked at; more is false) is the owner's signature of this release under
// any of the keys.
const MAX_SIGS = 16;
export function verifyRelease(n, sha, sigs, keys = RELEASE_KEYS) {
  if (!validN(n) || typeof sha !== 'string' || !SHA_RE.test(sha)) return false;
  if (!Array.isArray(sigs) || sigs.length === 0 || sigs.length > MAX_SIGS || !Array.isArray(keys) || keys.length === 0) return false;
  const message = Buffer.from(releaseMessage(n, sha));
  for (const raw of keys) {
    let key;
    try {
      if (typeof raw !== 'string' || Buffer.from(raw, 'base64').length !== 32) continue;
      key = publicKeyObject(raw);
    } catch {
      continue;
    }
    for (const sig of sigs) {
      try {
        if (typeof sig === 'string' && SIG_RE.test(sig) && crypto.verify(null, message, key, Buffer.from(sig, 'base64url'))) return true;
      } catch {
        // A signature that cannot be checked counts as not matching this key.
      }
    }
  }
  return false;
}

// `node release-keys.mjs verify <sha> <n> <sigs>`: exit 0 when the release is signed, 1 when not, and print nothing.
// ACP_RELEASE_KEYS_FILE names a JSON file holding an array of raw keys that replaces RELEASE_KEYS here, for tests. The
// hub and the worker never read it.
function verifyCommand([sha, n, sigs]) {
  try {
    const file = process.env.ACP_RELEASE_KEYS_FILE;
    const keys = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : RELEASE_KEYS;
    const number = /^[0-9]+$/.test(n ?? '') ? Number(n) : NaN;
    return verifyRelease(number, sha, (sigs ?? '').split(','), keys) ? 0 : 1;
  } catch {
    return 1;
  }
}

function isMainModule() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [command, ...args] = process.argv.slice(2);
  process.exit(command === 'verify' ? verifyCommand(args) : 1);
}
