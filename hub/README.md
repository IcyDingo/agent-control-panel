# The hub

A small hosted service that gives every Agent Control Panel a page of its own: a public galaxy at `/@handle` that draws
the work its Mac has done as a planet, a profile, and an approval step that connects a Mac to an account. One Node
process, one SQLite file, no build step and no dependencies. It needs **Node 22.13 or newer** (it uses the built-in
`node:sqlite`).

## Run it on your laptop

```sh
HUB_DEV_LOGIN=1 node --no-warnings=ExperimentalWarning hub/server.mjs
```

Open http://127.0.0.1:4848. `HUB_DEV_LOGIN=1` turns on a sign-in that needs no GitHub: post a name to `/auth/dev` and you
are that account.

```sh
curl -X POST -H 'content-type: application/json' -H 'origin: http://127.0.0.1:4848' \
  -d '{"login":"alice"}' -c cookies.txt http://127.0.0.1:4848/auth/dev
```

To sign a browser in, run the same call from the page's own console:
`fetch('/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"login":"alice"}' })`.
The dev sign-in is refused when `HUB_PUBLIC_URL` is an https address.

## Settings

All of them are environment variables, read once at start-up.

| Variable | Default | What it does |
|---|---|---|
| `HUB_PORT` | `4848` | The port to listen on. |
| `HUB_DATA` | `./data` | The folder for the database (`hub.sqlite`); made if missing. |
| `HUB_PUBLIC_URL` | `http://127.0.0.1:<port>` | The address people reach the hub at. Its origin is what writes from a browser must come from, and an `https` address marks the cookies `Secure`. |
| `HUB_GITHUB_CLIENT_ID` | none | The GitHub OAuth App's client id. |
| `HUB_GITHUB_CLIENT_SECRET` | none | Its client secret. Sign-in with GitHub needs both. |
| `HUB_DEV_LOGIN` | off | `1` allows the dev sign-in. Never on a public hub. |
| `HUB_HOST` | `0.0.0.0` | The address to listen on. Behind Caddy on the same machine, `127.0.0.1` keeps the plain-http port off the internet. In a container leave it, Docker's port mapping does the binding. |
| `HUB_TRUST_PROXY` | off | `1` says the hub sits behind a proxy and takes each visitor's address from the last entry of `X-Forwarded-For` (the one the proxy appended), but only on connections that come from loopback or a private range, where a proxy of yours would be. From anywhere else, and when off, the header is ignored. |
| `HUB_RELEASE` | none | The commit (full sha) this hub runs, with `HUB_RELEASE_N` and `HUB_RELEASE_SIG`; workers install and update to it. The deploy script writes it; unset, /api/release answers 503. |
| `HUB_RELEASE_N` | none | The release number, the commit count on `main`; it only goes up. |
| `HUB_RELEASE_SIG` | none | The owner's signatures of the release, separated by commas. The release is served only when one of them verifies against `release-keys.mjs`; otherwise /api/release answers 503. |

## Sign in with GitHub

1. On GitHub, open Settings, Developer settings, OAuth Apps, New OAuth App.
2. Homepage URL: your `HUB_PUBLIC_URL`. Authorization callback URL: `<HUB_PUBLIC_URL>/auth/github/callback`.
3. Generate a client secret, then start the hub with `HUB_GITHUB_CLIENT_ID` and `HUB_GITHUB_CLIENT_SECRET` set.

## Limits

Every call that signs in, costs something or changes something is rate-limited, in memory, per visitor address or per
account. Past the limit the answer is `429 {"ok":false,"error":"Too many requests; try again in N seconds."}` with a
`retry-after: N` header, and nothing was read or changed. The rates (`hub/limits.mjs`), each a burst of that many
calls and then that many per minute:

| What | Per | Rate |
|---|---|---|
| Starting or finishing a GitHub sign-in, the dev sign-in | address | 10 a minute |
| A Mac asking for a device code | address | 5 a minute |
| A Mac polling for its token | address | 30 a minute (a code also paces itself with `slow_down`) |
| Approving or denying a code, making a link | account | 10 a minute |
| Editing the profile | account | 10 a minute |
| A Mac pushing its galaxy | account | 12 a minute |
| A Mac pushing its status | account | 30 a minute |
| Placing an order | account | 10 a minute |
| Claiming or finishing an order | account | 30 a minute |

Behind a proxy every connection comes from the proxy's address, so set `HUB_TRUST_PROXY=1` there or every visitor
shares one bucket. An IPv6 visitor is their whole /64: one person holds that many addresses, so they share a bucket.

An **unlisted** galaxy (a choice on the profile page) is reached by its link and nothing else: its page and its API
answer carry `X-Robots-Tag: noindex`, and it cannot be found by its coordinates. `robots.txt` allows `/` and `/@…`
and keeps crawlers out of `/api/`, `/me` and `/device`.

## Releases

A release is a commit on `main`, a number, and one signature per signing key. The number is the commit count on `main`
(`git rev-list --count`), so it only ever goes up. The signature covers the number and the commit together, so nobody
can give an old commit a new number. The hub serves the release at `/api/release`, and a worker installs nothing else:
not what GitHub says is newest, and never a number lower than the one it already runs. Every step below runs on the
maintainer's Mac, in a checkout of this repository.

Make the signing key once:

```sh
node tools/release.mjs keygen
```

It asks for a passphrase twice, writes the key encrypted to `~/.config/agent-panel/signing-key.pem` (mode 600, never
overwritten) and prints the public key as one line. Paste that line into `RELEASE_KEYS` in `release-keys.mjs`, as the
comment there shows, and commit it.

```js
export const RELEASE_KEYS = [
  'base64…', // added 2026-10-22
];
```

Back the key file up, for example in a password manager, and keep its passphrase apart from it. The folder is outside
`~/Library/Application Support/Agent Panel`, so the uninstall steps do not delete it. A lost key or a forgotten
passphrase means nobody can sign a release: every worker has to be re-installed with the one line. The check is never
weakened to get around it. A key file restored from a backup must get its mode back (`chmod 600`), or `sign` refuses it.

To release, check out `main` with nothing uncommitted, pull, and sign:

```sh
node tools/release.mjs sign
```

`sign` refuses a commit that is not on `origin/main` and a working tree with changes. It asks for the passphrase once and
opens every key file in the folder with it. It prints `HUB_RELEASE=`, `HUB_RELEASE_N=` and `HUB_RELEASE_SIG=` and, last,
the ssh line that deploys the release. Set `ACP_HUB=https://universe.cashegg.com` and it also lists the commits since the
release the hub serves now. Set `ACP_RELEASE_HOST=root@<host>` and the ssh line names your server; copy it, or let the
tool run it for you:

```sh
node tools/release.mjs sign --deploy root@<host>[:/srv/agent-hub]
```

The first signed release is a little different; `deploy/README.md` has the steps. The number of a release counts as used
once `update.sh` has written it, so if the build fails after that, fix it in a new commit and `sign` again.

To rotate the key, make a second one with `node tools/release.mjs keygen`. It is written to `signing-key-2.pem`, and
`sign` now signs with both. `sign` opens every key file with the one passphrase it asks for, so the new key must be made
with the same passphrase as the current one. Add the new public key to `RELEASE_KEYS`, commit, and release. From then on
every release carries two signatures, so a worker on either side of that commit follows. Wait 30 days: a worker checks
daily, and one that has been asleep longer has to be re-installed. Then delete the old key file and remove its line from
`RELEASE_KEYS` in a release that the new key alone signs.

If a key is stolen (the file and its passphrase), do the same at once and without the wait: remove it from
`RELEASE_KEYS` in a release signed by the key or keys that remain. Until a worker has that release, the thief can sign
only a commit that is on `main` and newer than what the worker runs, so they would also need the GitHub account, and
`main` is protected so that even the account can change it only through a pull request made in the open. Keep that
protection on; the design counts on it.

A worker that refuses a release says so, and keeps running the release it has. On that Mac, the `status` command
prints the last check, for example `Last update check <time>: Release 1a2b3c4 is not signed by a known key.` or
`Release 1a2b3c4 is older than the one running.`:

```sh
node "$HOME/Library/Application Support/Agent Panel/worker/current/server.mjs" status
```

## Behind Caddy

The hub speaks plain http; let Caddy hold the certificate.

```
hub.example.com {
  reverse_proxy 127.0.0.1:4848
}
```

Set `HUB_PUBLIC_URL=https://hub.example.com`, `HUB_TRUST_PROXY=1`, and `HUB_HOST=127.0.0.1` so that only Caddy can
reach the plain-http port (in Docker, bind the mapping to 127.0.0.1 instead, as below).

## Docker

Build from the repository root, because the image needs `world.mjs` and `public/world.js` as well as `hub/`:

```sh
docker build -f hub/Dockerfile -t agent-hub .
docker run -d -p 127.0.0.1:4848:4848 -v hub-data:/data \
  -e HUB_PUBLIC_URL=https://hub.example.com -e HUB_TRUST_PROXY=1 \
  -e HUB_GITHUB_CLIENT_ID=… -e HUB_GITHUB_CLIENT_SECRET=… agent-hub
```

The database lives in the `/data` volume. Binding to `127.0.0.1` keeps the plain-http port off the internet; only
Caddy reaches it. The same as a compose file, which also brings it back after a reboot:

```yaml
services:
  hub:
    image: agent-hub
    restart: unless-stopped
    ports: ["127.0.0.1:4848:4848"]
    volumes: ["hub-data:/data"]
    environment:
      HUB_PUBLIC_URL: https://hub.example.com
      HUB_TRUST_PROXY: "1"
      HUB_GITHUB_CLIENT_ID: …
      HUB_GITHUB_CLIENT_SECRET: …
volumes:
  hub-data:
```

The Universe itself (universe.cashegg.com) is deployed from the files in [`deploy/`](deploy/README.md), which also say
what to watch for behind Cloudflare.

## Backup

Everything the hub keeps is in one database, `data/hub.sqlite`. It runs in WAL mode, so recent writes sit in the
`hub.sqlite-wal` and `hub.sqlite-shm` files beside it until SQLite folds them in, and copying the main file while the hub
runs can give a stale or inconsistent copy. Stop the hub first, then copy:

```sh
cp data/hub.sqlite backups/hub-$(date +%F).sqlite
```

To back up while it runs, let SQLite make the copy:

```sh
sqlite3 data/hub.sqlite ".backup backups/hub-$(date +%F).sqlite"
```
