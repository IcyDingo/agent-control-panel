# The hub

A small hosted service that gives every Agent Control Panel a page of its own: a public system at `/@handle` that draws
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

## Sign in with GitHub

1. On GitHub, open Settings, Developer settings, OAuth Apps, New OAuth App.
2. Homepage URL: your `HUB_PUBLIC_URL`. Authorization callback URL: `<HUB_PUBLIC_URL>/auth/github/callback`.
3. Generate a client secret, then start the hub with `HUB_GITHUB_CLIENT_ID` and `HUB_GITHUB_CLIENT_SECRET` set.

## Before it faces the internet

The hub has no rate limits yet (they come in slice 8), so it is not ready for the open internet until they land; the
steps below are for a hub you reach yourself.

## Behind Caddy

The hub speaks plain http; let Caddy hold the certificate.

```
hub.example.com {
  reverse_proxy 127.0.0.1:4848
}
```

Set `HUB_PUBLIC_URL=https://hub.example.com`.

## Docker

Build from the repository root, because the image needs `world.mjs` and `public/world.js` as well as `hub/`:

```sh
docker build -f hub/Dockerfile -t agent-hub .
docker run -d -p 4848:4848 -v hub-data:/data -e HUB_PUBLIC_URL=https://hub.example.com agent-hub
```

The database lives in the `/data` volume.

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
