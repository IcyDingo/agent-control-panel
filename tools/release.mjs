// The owner's release tool; it runs on the owner's Mac and nowhere else. `keygen` makes a signing key and keeps it
// encrypted under a passphrase; `sign` signs a commit that is already on origin/main as "<n> <sha>" with every key the
// owner has, and prints the three settings and the ssh line that deploy it.
//   node tools/release.mjs keygen
//   node tools/release.mjs sign [sha] [--deploy user@host[:dir]]
// The private key and the passphrase are never printed, logged or put on a command line.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SHA_RE, signRelease, rawPublicKey } from '../release-keys.mjs';

const KEY_FILE_RE = /^signing-key(-(\d+))?\.pem$/;
const DEFAULT_DIR = '/srv/agent-hub';

export function keyDir(env = process.env) {
  return env.ACP_SIGNING_KEY || path.join(os.homedir(), '.config', 'agent-panel');
}

// `signing-key.pem` is the first key, `signing-key-2.pem` the second, and so on; returned in that order.
export function keyFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const number = (name) => Number(KEY_FILE_RE.exec(name)[2] ?? 1);
  return names.filter((name) => KEY_FILE_RE.test(name)).sort((a, b) => number(a) - number(b)).map((name) => path.join(dir, name));
}

function nextKeyFile(dir) {
  const last = keyFiles(dir).map((file) => Number(KEY_FILE_RE.exec(path.basename(file))[2] ?? 1)).pop() ?? 0;
  return path.join(dir, last === 0 ? 'signing-key.pem' : `signing-key-${last + 1}.pem`);
}

export function keygen({ dir, passphrase }) {
  if (!passphrase) throw new Error('A passphrase is required.');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = nextKeyFile(dir);
  fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
  return { file, publicKey: rawPublicKey(publicKey) };
}

export function loadKey(file, passphrase) {
  if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error(`${file} must be mode 0600.`);
  try {
    return crypto.createPrivateKey({ key: fs.readFileSync(file), passphrase });
  } catch {
    throw new Error(`The passphrase did not open ${file}.`);
  }
}

// `run` is (cmd, args, opts) → Promise<{ err, stdout, stderr }>; every git call runs in `cwd`.
export async function sign({ sha, dir, passphrase, cwd = process.cwd(), run }) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new Error('Give the full 40-character commit hash, in lower case.');
  const git = (...args) => run('git', args, { cwd });
  const status = await git('status', '--porcelain');
  if (status.err) throw new Error(`git status failed: ${status.stderr.trim()}`);
  if (status.stdout.trim() !== '') throw new Error('The working tree has changes; commit or discard them first.');
  if ((await git('merge-base', '--is-ancestor', sha, 'origin/main')).err) throw new Error(`${sha.slice(0, 7)} is not on origin/main; push it first.`);
  const files = keyFiles(dir);
  if (files.length === 0) throw new Error('No signing key; run  node tools/release.mjs keygen  first.');
  const count = await git('rev-list', '--count', sha);
  if (count.err) throw new Error(`git rev-list failed: ${count.stderr.trim()}`);
  const n = Number(count.stdout);
  return { sha, n, sigs: files.map((file) => signRelease(n, sha, loadKey(file, passphrase))) };
}

export function printed({ sha, n, sigs, host, dir = DEFAULT_DIR }) {
  const joined = sigs.join(',');
  return [`HUB_RELEASE=${sha}`, `HUB_RELEASE_N=${n}`, `HUB_RELEASE_SIG=${joined}`, `ssh ${host ?? '<host>'} ${dir}/update.sh ${sha} ${n} ${joined}`];
}

// The passphrase from ACP_SIGNING_PASSPHRASE, else typed on the terminal with nothing echoed.
function askPassphrase(prompt, env) {
  if (env.ACP_SIGNING_PASSPHRASE) return Promise.resolve(env.ACP_SIGNING_PASSPHRASE);
  if (!process.stdin.isTTY) return Promise.reject(new Error('No terminal to ask the passphrase on; set ACP_SIGNING_PASSPHRASE.'));
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    process.stderr.write(prompt);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

// `user@host` or `user@host:dir`, split on the first colon.
function splitHost(value) {
  const colon = value.indexOf(':');
  return colon === -1 ? { host: value, dir: DEFAULT_DIR } : { host: value.slice(0, colon), dir: value.slice(colon + 1) || DEFAULT_DIR };
}

// The commits between the release the hub serves now and the one being signed, so the owner sees what they are shipping.
// Any failure is skipped silently: the hub being unreachable or unsigned is no reason to stop a release.
async function sinceServed({ hub, sha, cwd, run, fetch }) {
  try {
    const res = await fetch(`${hub.replace(/\/+$/, '')}/api/release`, { signal: AbortSignal.timeout(4000) });
    const body = await res.json();
    if (!body?.ok || typeof body.sha !== 'string' || !SHA_RE.test(body.sha)) return null;
    if ((await run('git', ['cat-file', '-e', `${body.sha}^{commit}`], { cwd })).err) return null;
    const log = await run('git', ['log', '--oneline', `${body.sha}..${sha}`], { cwd });
    return log.err ? null : `Since the release the hub serves (${body.sha.slice(0, 7)}):\n${log.stdout.trimEnd()}`;
  } catch {
    return null;
  }
}

function parseSignArgs(args) {
  const out = { sha: null, deploy: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--deploy') {
      out.deploy = args[++i];
      if (!out.deploy) throw new Error('--deploy needs user@host[:dir].');
    } else if (!out.sha && !args[i].startsWith('-')) {
      out.sha = args[i];
    } else {
      throw new Error(`Unknown argument ${args[i]}.`);
    }
  }
  return out;
}

export async function main(argv, { env = process.env, run, fetch = globalThis.fetch, cwd = process.cwd(), out = (line) => console.log(line), err = (line) => console.error(line) } = {}) {
  try {
    const [command, ...args] = argv;
    const dir = keyDir(env);
    if (command === 'keygen') {
      const passphrase = await askPassphrase('Passphrase for the new key: ', env);
      if (!env.ACP_SIGNING_PASSPHRASE && (await askPassphrase('Again: ', env)) !== passphrase) throw new Error('The passphrases differ.');
      const { file, publicKey } = keygen({ dir, passphrase });
      out(`Public key: ${publicKey}`);
      out('Paste it into RELEASE_KEYS in release-keys.mjs, then commit.');
      out(`Back the file up: ${file}. Without it and its passphrase no release can be signed; losing it means re-installing every worker.`);
      return 0;
    }
    if (command === 'sign') {
      const { sha: given, deploy } = parseSignArgs(args);
      const sha = given ?? (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
      const passphrase = await askPassphrase('Passphrase: ', env);
      const { n, sigs } = await sign({ sha, dir, passphrase, cwd, run });
      const target = splitHost(deploy ?? env.ACP_RELEASE_HOST ?? '');
      const host = target.host || null;
      if (env.ACP_HUB) {
        const since = await sinceServed({ hub: env.ACP_HUB, sha, cwd, run, fetch });
        if (since) err(since);
      }
      for (const line of printed({ sha, n, sigs, host, dir: target.dir })) out(line);
      if (!deploy) return 0;
      const ssh = await run('ssh', [host, `${target.dir}/update.sh`, sha, String(n), sigs.join(',')], { stdio: 'inherit' });
      return ssh.err ? (typeof ssh.err.code === 'number' ? ssh.err.code : 1) : 0;
    }
    throw new Error('Usage: node tools/release.mjs keygen | sign [sha] [--deploy user@host[:dir]]');
  } catch (e) {
    err(e.message);
    return 1;
  }
}

// What the command line runs git and ssh with. With stdio 'inherit' the owner sees the command's own output.
function cliRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    if (opts.stdio === 'inherit') {
      const child = spawn(cmd, args, opts);
      child.on('error', (err) => resolve({ err, stdout: '', stderr: '' }));
      child.on('close', (code) => resolve({ err: code === 0 ? null : Object.assign(new Error(`${cmd} exited with ${code}`), { code: code ?? 1 }), stdout: '', stderr: '' }));
      return;
    }
    execFile(cmd, args, opts, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

function isMainModule() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exit(await main(process.argv.slice(2), { run: cliRun }));
}
