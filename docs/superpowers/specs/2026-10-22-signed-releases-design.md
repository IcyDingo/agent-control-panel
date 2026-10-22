# Signed releases: a worker installs only what the owner signed

Design, 2026-10-22. Follows the easy-install design (2026-10-22-easy-install-design.md), which deferred this.
**(owner)** = decided by the owner. **(call)** = decided here, marked for review.

## Intent

A worker installs, once a day, the commit the hub names, as long as that commit is on the repository's `main` at
GitHub. So whoever holds the GitHub account decides what runs on every worker Mac. The owner wants a second lock
**(owner)**: a release must also carry a signature made with a private key that lives only on the owner's Mac. Then
pushing code to the installed base needs the GitHub account *and* that key.

## Goals

- Every release the hub names is signed; a worker refuses one that is not, before it downloads anything.
- The hub refuses to serve an unsigned or badly signed release, so a misdeploy is caught on the server, not on a
  thousand Macs.
- Releasing stays one command for the owner.
- Keys can be rotated without re-installing workers.

## Non-goals

- Signing the install script or the Download page: the hub is the trust root for a first install, and a signature the
  hub also serves proves nothing. The script stays readable at `/install` and the README carries the line.
- Apple code signing or notarization.
- Signing the archive bytes: the commit sha pins the content and GitHub serves it over https; signing the sha is enough.

## Anti-goals (it fails even if it works when)

- The private key ends up on the server, in the repo, in `.env`, or in a log: the key is generated on the owner's
  Mac, stored 0600, and never leaves it; the hub holds only public keys.
- Losing the key strands every worker: the key is one file the owner is told to back up at generation time, and a
  lost key is survivable by a re-install (the one line), never by weakening the check.
- A stale worker cannot follow a key rotation: a worker accepts any of a *list* of public keys, and a new key is
  shipped in a release signed by the old one.

## How it works

```
owner's Mac                          server (hub)                               worker Mac (daily)
node tools/release.mjs sign  ──ssh──▶  update.sh <sha> <sigs>                    GET /api/release → { sha, sigs }
  reads ~/.config/agent-panel/*.pem     release.env: HUB_RELEASE, HUB_RELEASE_SIG   verifyRelease(sha, sigs, RELEASE_KEYS)
  signs the 40-hex sha (Ed25519)        hub verifies at start; 503 if bad          then compare to main, download
```

- **Key:** Ed25519 (`node:crypto`, no dependency). `node tools/release.mjs keygen` writes
  `~/.config/agent-panel/signing-key.pem` (PKCS8 PEM, mode 0600, never overwritten) and prints the public key as one
  base64 line to paste into `release-keys.mjs`, plus the sentence to back the file up **(call: a file, not the
  keychain, so it can be copied into a password manager and restored; and a folder outside
  `~/Library/Application Support/Agent Panel`, which the uninstall steps tell people to delete)**. `ACP_SIGNING_KEY`
  names another path. The tool keeps every key it has made; `sign` uses all of them (below).
- **What is signed:** the release's 40-hex sha as UTF-8 bytes. A signature is 64 bytes, carried as base64url. A
  release carries **one signature per current key**, comma-separated in `HUB_RELEASE_SIG` and as `sigs: [...]` in the
  API, so a worker that still trusts only an older key follows a rotation without a gap **(call)**.
- **`release-keys.mjs`** (repo root, shared by hub and worker): `export const RELEASE_KEYS = ['<base64 raw 32-byte
  public key>', …]` with a comment per key (date added). `verifyRelease(sha, sigs, keys = RELEASE_KEYS) → boolean`:
  true when **any** signature verifies under **any** listed key.
- **Hub:** `HUB_RELEASE_SIG` joins `HUB_RELEASE` in `release.env`. `config.release` is set only when the sha is
  40-hex **and** at least one signature verifies against `RELEASE_KEYS`; otherwise `/api/release` answers 503 with
  `This hub's release is not signed by a known key.` (unset sha keeps today's sentence). `/api/release` returns
  `{ ok, sha, sigs, url }`. The Dockerfile copies `release-keys.mjs`.
- **Deploy:** `update.sh <sha> <sigs>` fetches, checks out that commit (`git checkout --detach <sha>`), writes both
  lines to `release.env`, builds, restarts, checks `/healthz` **and** `/api/release` (a 503 fails the script with
  the hub's sentence). With no arguments it keeps today's behaviour (pull main, `HUB_RELEASE` only) **until the first
  signed release has been deployed**; after that `release.env` carries a signature and a plain `update.sh` refuses
  with `This hub serves signed releases: run  node tools/release.mjs sign  on your Mac and use the line it prints.`
  **(call: a plain deploy would otherwise take new installs down too, since the install script reads
  `/api/release`)**.
- **Owner's command:** `node tools/release.mjs sign [sha]` (default: the local HEAD, which must be on `origin/main`;
  it refuses a dirty tree or a sha not on `origin/main`) signs with every key in `~/.config/agent-panel/` and prints
  `HUB_RELEASE=…`, `HUB_RELEASE_SIG=…` and the ready ssh line: `ssh root@<host> /srv/agent-hub/update.sh <sha>
  <sigs>`. With `--deploy root@host:/srv/agent-hub` it runs that line itself **(call)**. The host comes from
  `ACP_RELEASE_HOST` or the flag; nothing about the server is in the repo beyond the deploy README.
- **Worker (`update.mjs`):** after the `held` check and before the compare: `verifyRelease(sha, sigs)` or
  `{ outcome: 'error', error: 'Release <7> is not signed by a known key.' }`. No download, no switch.
- **Rotation (routine):** `keygen` a second key (the tool now signs with both); add its public key to `RELEASE_KEYS`
  in a commit; release. Every release from then on carries two signatures, so a worker on either side of that commit
  follows. After 30 days (a worker checks daily; one asleep longer re-installs), delete the old key file and remove it
  from `RELEASE_KEYS` in a release signed by the new key alone **(call: no version tracking on the hub this round;
  the hub records nothing about which version a worker runs)**. Written in `hub/README.md` under "Releases".
- **A stolen key** is handled the same way, faster: remove it from `RELEASE_KEYS` in a release signed by the
  remaining key(s). Until a worker has that release, a hub under the thief's control could still point it at an
  **old** release the stolen key once signed; that is a downgrade to a real commit of `main`, never new code
  **(call: no epoch or ordering in what is signed this round)**.
- **Install script:** unchanged; it trusts the hub it was served by (stated in the easy-install design).

## Nothing unwanted reaches the server **(owner)**

The owner's rule for all of this: whatever is built, nothing unwanted may get into the server. What this design does
about it:

- **No new way in.** The only new route is a change to `GET /api/release`, which stays public, read-only and
  rate-limited like today. Nothing on the server listens for releases, signatures or keys; the server never pulls
  code on its own.
- **Deploys happen only over SSH**, from the owner's Mac, with a key (passwords were turned off on 2026-10-22).
  `release.mjs --deploy` is that same ssh line, run for the owner; the hub has no "deploy" endpoint.
- **The server runs only what the owner signed.** In signed mode `update.sh` checks out exactly the sha it was
  given, and it verifies `<sha> <sigs>` against the keys of the code it currently runs **before** fetching or
  building anything **(call; skipped only while `src/release-keys.mjs` does not exist yet, the bootstrap deploy)**.
  After the first signed release, plain `update.sh` is refused. So a stolen GitHub account can push to `main`, but
  cannot put that code on the server or on any worker: both need the key on the owner's Mac.
- **The private key never touches the server**, the repo, `.env`, a log or a shell history: `sign` reads the key
  file itself and prints only the signature.
- **Workers can do nothing to the server** beyond today's authenticated API calls; a release carries no instruction
  from a worker to the hub.
- Unchanged and still true: 80/443 open to Cloudflare only, SSH keys-only, the hub in a container with `.env`
  outside the image.

## Decisions

| Topic | Decision |
|---|---|
| Algorithm | Ed25519 from `node:crypto`; signature over the sha's UTF-8 bytes **(call)** |
| Where the key lives | `~/.config/agent-panel/signing-key.pem` (outside the folder the uninstall steps delete), 0600, backed up by the owner **(call)** |
| Who verifies | Both: the hub at start (serves 503 if bad) and the worker before download **(call)** |
| Multiple keys | A list in `release-keys.mjs`; a release carries one signature per current key; any pair that verifies is enough **(call)** |
| Release command | `node tools/release.mjs sign` prints the ssh line; `--deploy` runs it **(call)** |
| Unsigned deploy | Allowed until the first signed release; refused after, with a sentence, because new installs read `/api/release` too **(call)** |
| Rotation gate | Time (30 days of double signing), not version tracking **(call)** |

## Tests

- `test/release-keys.test.mjs`: `verifyRelease` accepts one good signature among bad ones, under any listed key;
  refuses a wrong key, a wrong sha, a truncated or non-base64url signature, an empty signature list and an empty key
  list.
- `test/release-tool.test.mjs`: with a temp HOME, `keygen` writes a 0600 PEM and prints a key that verifies; a second
  `keygen` makes a second file rather than overwriting; `sign <sha>` prints the two lines (one signature per key
  file) and the ssh line, and each signature verifies under its key; a sha not on `origin/main` is refused (a temp
  git repo with an `origin`).
- `test/hub-db.test.mjs`: `config.release` null without a valid signature; set with one made by a test key injected
  through `loadConfig(env, { keys })` **(call: the key list is injectable for tests)**.
- `test/hub-api.test.mjs`: `/api/release` carries `sigs`; 503 with the new sentence when every signature is wrong.
- `test/update.test.mjs`: a release without `sigs`, with only bad ones, or signed by an unknown key is an error with
  no download and no compare call; a good one among bad ones proceeds (keys injected: `checkForUpdate({ …, keys })`).
- `sh -n hub/deploy/update.sh`; `update.sh` run in a temp folder with a fake `docker`/`curl` on PATH: no arguments
  and a signed `release.env` → refused with the sentence; `<sha> <sigs>` with a bad signature → refused before any
  fetch; a good one → checks out the sha and writes both lines.
- The deploy README's release steps followed once by hand.

## Rollout

1. `release-keys.mjs`, the tool, the tests. The owner runs `keygen` and pastes the public key; that commit is the
   first one that can be signed.
2. Hub: config, route, Dockerfile, `update.sh`, deploy README, hub README "Releases".
3. Worker: `update.mjs` check. Deploy this release **signed**: from then on every worker verifies.
4. Until step 3 is deployed, existing workers (none in the wild yet besides the owner's) accept unsigned releases.
