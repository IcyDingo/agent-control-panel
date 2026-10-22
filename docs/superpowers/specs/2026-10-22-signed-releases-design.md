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
node tools/release.mjs sign  ──ssh──▶  update.sh <sha> <n> <sigs>                GET /api/release → { sha, n, sigs }
  decrypts ~/.config/agent-panel/*.pem  verifies first, refuses a lower n          verifyRelease(n, sha, sigs, RELEASE_KEYS)
  signs "<n> <sha>" (Ed25519)           release.env: HUB_RELEASE, _N, _SIG          refuses a lower n; on main? after the running one? download
```

- **Key:** Ed25519 (`node:crypto`, no dependency). `node tools/release.mjs keygen` writes
  `~/.config/agent-panel/signing-key.pem` (PKCS8 PEM, mode 0600, never overwritten) and prints the public key as one
  base64 line to paste into `release-keys.mjs`, plus the sentence to back the file up **(call: a file, not the
  keychain, so it can be copied into a password manager and restored; and a folder outside
  `~/Library/Application Support/Agent Panel`, which the uninstall steps tell people to delete)**. `ACP_SIGNING_KEY`
  names another path. The tool keeps every key it has made; `sign` uses all of them (below).
- **The key file is encrypted** with a passphrase (PKCS8, aes-256-cbc, as `node:crypto` exports it). `keygen` asks
  for the passphrase twice without echo; `sign` asks once. A copied file alone signs nothing. A forgotten passphrase
  is a lost key: re-install the workers, never weaken the check. `ACP_SIGNING_PASSPHRASE` feeds it for tests only
  **(owner: lock it down as far as it goes)**.
- **What is signed:** the UTF-8 bytes of `<n> <sha>`, where `n` is the release number: the number of commits
  reachable from the sha (`git rev-list --count <sha>`). On a protected `main` with no force pushes, every later
  commit on `main` has a larger `n`, so `n` orders releases, and the signature binds it to the sha so nobody without
  the key can give an old sha a new number. A signature is 64 bytes, carried as base64url. A release carries **one
  signature per current key**, comma-separated in `HUB_RELEASE_SIG` and as `sigs: [...]` in the API, so a worker that
  still trusts only an older key follows a rotation without a gap **(call)**.
- **No going back:** the hub, the deploy script and the worker each refuse a release whose `n` is lower than the one
  they already have. Whoever holds the key chooses `n`, though, and can give an old commit any number; so the worker
  also asks GitHub whether the new release descends from the one it runs, and only that descent check stops a stolen
  key from pointing a worker at older code **(owner: lock it down as far as it goes)**.
- **`release-keys.mjs`** (repo root, shared by hub and worker): `export const RELEASE_KEYS = ['<base64 raw 32-byte
  public key>', …]` with a comment per key (date added). `releaseMessage(n, sha) → '<n> <sha>'` and
  `verifyRelease(n, sha, sigs, keys = RELEASE_KEYS) → boolean`: true when `n` is a positive integer, the sha is
  40-hex, and **any** signature verifies under **any** listed key.
- **Hub:** `HUB_RELEASE_N` and `HUB_RELEASE_SIG` join `HUB_RELEASE` in `release.env`. `config.release` is set only
  when `verifyRelease` passes against `RELEASE_KEYS`; otherwise `/api/release` answers 503 with
  `This hub's release is not signed by a known key.` (unset sha keeps today's sentence). `/api/release` returns
  `{ ok, sha, n, sigs, url }`. The Dockerfile copies `release-keys.mjs`.
- **Deploy:** `update.sh <sha> <n> <sigs>`: first verifies the three against the keys of the code it currently runs
  (`node src/release-keys.mjs verify <sha> <n> <sigs>`; skipped only while that file does not exist, the bootstrap
  deploy) and refuses an `n` not above the one in `release.env`; only then fetches, checks out that commit
  (`git checkout --detach <sha>`), writes the three lines, builds, restarts, checks `/healthz` **and** `/api/release`
  (a 503 fails the script with the hub's sentence). With no arguments it keeps today's behaviour (pull main,
  `HUB_RELEASE` only) **until the first signed release has been deployed**; after that `release.env` carries a
  signature and a plain `update.sh` refuses with
  `This hub serves signed releases: run  node tools/release.mjs sign  on your Mac and use the line it prints.`
  **(call: a plain deploy would otherwise take new installs down too, since the install script reads
  `/api/release`)**.
- **Owner's command:** `node tools/release.mjs sign [sha]` (default: the local HEAD, which must be on `origin/main`;
  it refuses a dirty tree or a sha not on `origin/main`, and refuses a key file that is not mode 0600) computes `n`,
  asks for the passphrase, signs with every key in `~/.config/agent-panel/`, shows the commits since the release the
  hub serves now (`GET /api/release` of `ACP_HUB`, when reachable) and prints `HUB_RELEASE=…`, `HUB_RELEASE_N=…`,
  `HUB_RELEASE_SIG=…` and the ready ssh line: `ssh root@<host> /srv/agent-hub/update.sh <sha> <n> <sigs>`. With
  `--deploy root@host:/srv/agent-hub` it runs that line itself **(call)**. The host comes from `ACP_RELEASE_HOST` or
  the flag; nothing about the server is in the repo beyond the deploy README.
- **Worker (`update.mjs`):** after the `held` check and before the compare: `verifyRelease(n, sha, sigs)` or
  `{ outcome: 'error', error: 'Release <7> is not signed by a known key.' }`; then `n` must not be below the number in
  the worker's `release` file (`<sha> <n>`, written at every switch; absent after a fresh install, so the first daily
  check sets it) or `{ outcome: 'error', error: 'Release <7> is older than the one running.' }`. After the compare to
  main, a second compare, `compare/<running sha>...<sha>`, must answer `ahead` (the running release is an ancestor of
  the new one); any other status, a non-OK answer or no answer is
  `{ outcome: 'error', error: 'Release <7> does not follow the release running here.' }`. No download, no switch. The
  number is a floor the key holder chooses, kept as a cheap first filter and the record `status` shows; the descent
  check is what stops a return to old code, an old commit given a large number, a commit from a side branch merged
  into `main` before the running release, or another commit at the same number.
- **Deploy key (documented, optional):** the deploy README shows how to give `release.mjs --deploy` its own ssh key
  whose `authorized_keys` line forces `command="/srv/agent-hub/update.sh"`, so that key can deploy and nothing else
  **(call: documented, not automated; the owner's admin key stays as it is)**.
- **Rotation (routine):** `keygen` a second key (the tool now signs with both); add its public key to `RELEASE_KEYS`
  in a commit; release. Every release from then on carries two signatures, so a worker on either side of that commit
  follows. After 30 days (a worker checks daily; one asleep longer re-installs), delete the old key file and remove it
  from `RELEASE_KEYS` in a release signed by the new key alone **(call: no version tracking on the hub this round;
  the hub records nothing about which version a worker runs)**. Written in `hub/README.md` under "Releases".
- **A stolen key** (file **and** passphrase) is handled the same way, faster: remove it from `RELEASE_KEYS` in a
  release signed by the remaining key(s). Until a worker has that release, the number the thief signs counts for
  nothing on its own: the worker installs only a commit that is on `main` **and** descends from the release it runs
  (the descent check), so they also need the GitHub account; with it, main's protection still demands a pull request
  they would have to open in the open.
- **Install script:** it trusts the hub it was served by (stated in the easy-install design). Besides the `switch`
  file it already removed, it now clears the worker's `release` and `last-check` records, so a fresh install starts
  without a floor and the first daily check sets it.

## Nothing unwanted reaches the server **(owner)**

The owner's rule for all of this: whatever is built, nothing unwanted may get into the server. What this design does
about it:

- **No new way in.** The only new route is a change to `GET /api/release`, which stays public, read-only and
  rate-limited like today. Nothing on the server listens for releases, signatures or keys; the server never pulls
  code on its own.
- **Deploys happen only over SSH**, from the owner's Mac, with a key (passwords were turned off on 2026-10-22).
  `release.mjs --deploy` is that same ssh line, run for the owner; the hub has no "deploy" endpoint.
- **The server runs only what the owner signed, and never goes back.** In signed mode `update.sh` checks out
  exactly the sha it was given, after verifying `<sha> <n> <sigs>` against the keys of the code it currently runs and
  refusing a lower `n` **before** fetching or building anything **(call; the verification is skipped only while
  `src/release-keys.mjs` does not exist yet, the bootstrap deploy)**. After the first signed release, plain
  `update.sh` is refused. So a stolen GitHub account can push to `main`, but cannot put that code on the server or on
  any worker: both need the key on the owner's Mac and its passphrase.
- **The private key never touches the server**, the repo, `.env`, a log or a shell history: `sign` reads the key
  file itself, decrypts it in memory with the passphrase, and prints only the signatures.
- **Workers can do nothing to the server** beyond today's authenticated API calls; a release carries no instruction
  from a worker to the hub.
- Unchanged and still true: 80/443 open to Cloudflare only, SSH keys-only, the hub in a container with `.env`
  outside the image.

## Keep the people who install it safe **(owner)**

Everyone who runs the one line hands a daily download-and-run to this project. What they get in return:

- **Their Mac runs only code the owner signed**, on `main`, descending from what it has. Not what GitHub says, not what
  the server says, not what a stolen key once said. All three must agree before a single byte is downloaded.
- **Nothing is downloaded before it is verified**, and nothing runs before the launcher's existing checks pass; a
  release that fails to start three times is rolled back as today.
- **A refused release is visible, never silent.** The next daily check records the sentence, `node server.mjs status`
  prints it, and the worker keeps running the release it has.
- **Nothing new is collected or sent.** The check sends the same `GET /api/release` as today; a signature is a few
  bytes more in the answer, not a new request from the Mac.
- **The install line stays readable** at `/install`, and the README keeps the sentence that a person can read it
  before running it.

## Decisions

| Topic | Decision |
|---|---|
| Algorithm | Ed25519 from `node:crypto`; signature over `<n> <sha>` where `n` orders releases **(call)** |
| Downgrades | Refused by the hub, the deploy script and the worker: `n` only goes up **(owner)**; the worker also requires the new release to descend from the one it runs, since the key holder chooses `n` **(call)** |
| Where the key lives | `~/.config/agent-panel/signing-key.pem` (outside the folder the uninstall steps delete), 0600, passphrase-encrypted, backed up by the owner **(owner: encrypted; call: the path)** |
| Who verifies | Both: the hub at start (serves 503 if bad) and the worker before download **(call)** |
| Multiple keys | A list in `release-keys.mjs`; a release carries one signature per current key; any pair that verifies is enough **(call)** |
| Release command | `node tools/release.mjs sign` prints the ssh line; `--deploy` runs it **(call)** |
| Unsigned deploy | Allowed until the first signed release; refused after, with a sentence, because new installs read `/api/release` too **(call)** |
| Rotation gate | Time (30 days of double signing), not version tracking **(call)** |

## Tests

- `test/release-keys.test.mjs`: `verifyRelease` accepts one good signature among bad ones, under any listed key;
  refuses a wrong key, a wrong sha, a wrong `n` (the same sha with `n+1`), `n` of `0`, `-1`, `1.5` or `'7'`, a
  truncated or non-base64url signature, an empty signature list and an empty key list; `verify` on the command line
  exits 0 or 1 accordingly.
- `test/release-tool.test.mjs`: with a temp HOME and `ACP_SIGNING_PASSPHRASE`, `keygen` writes a 0600 PEM that is
  encrypted (contains `ENCRYPTED PRIVATE KEY`) and prints a key that verifies; a second `keygen` makes a second file
  rather than overwriting; `sign <sha>` prints the three lines (one signature per key file) with `n` equal to
  `git rev-list --count`, and the ssh line, and each signature verifies under its key; a wrong passphrase, a 0644 key
  file and a sha not on `origin/main` are refused (a temp git repo with an `origin`).
- `test/hub-db.test.mjs`: `config.release` null without a valid signature or without `n`; set with one made by a test
  key injected through `loadConfig(env, { keys })` **(call: the key list is injectable for tests)**.
- `test/hub-api.test.mjs`: `/api/release` carries `n` and `sigs`; 503 with the new sentence when every signature is
  wrong.
- `test/update.test.mjs`: a release without `sigs`, with only bad ones, signed by an unknown key, or with `n` below
  the worker's `release` file is an error with no download and no compare call (two sentences); a good one among bad
  ones proceeds and a switch writes `release` as `<sha> <n>` (keys injected: `checkForUpdate({ …, keys })`); a
  release whose compare with the running one answers anything but `ahead`, a 404 or no answer is an error with no
  download (the third sentence), and a switch asks main's compare first, then the descent.
- `sh -n hub/deploy/update.sh`; `update.sh` run in a temp folder with a fake `docker`/`curl`/`node` on PATH: no
  arguments and a signed `release.env` → refused with the sentence; a bad signature or a lower `n` → refused before
  any fetch; a good one → checks out the sha and writes the three lines.
- The deploy README's release steps followed once by hand.

## Rollout

1. `release-keys.mjs`, the tool, the tests. The owner runs `keygen` and pastes the public key; that commit is the
   first one that can be signed.
2. Hub: config, route, Dockerfile, `update.sh`, deploy README, hub README "Releases".
3. Worker: `update.mjs` check. Deploy this release **signed**: from then on every worker verifies.
4. Until step 3 is deployed, existing workers (none in the wild yet besides the owner's) accept unsigned releases.
