# How the Universe is deployed

The hub runs on one server behind Caddy, as a container built from a clone of this repository. These files are what
sits in `/srv/agent-hub` there; nothing in them is secret.

```
/srv/agent-hub
  src/                  git clone of this repository (main)
  compose.yml           builds hub/Dockerfile from src and runs it on 127.0.0.1:4848, database in the hub-data volume
  .env                  the settings, from env.example (the GitHub id and secret live only here, mode 600)
  update.sh             pull main, rebuild, restart, ask /healthz
  caddy-cloudflare.sh   rewrites the site's Caddy block: Cloudflare's ranges as trusted proxies, the real visitor in X-Forwarded-For
```

First time:

```sh
mkdir -p /srv/agent-hub && cd /srv/agent-hub
git clone --depth 1 https://github.com/IcyDingo/agent-control-panel src
cp src/hub/deploy/{compose.yml,update.sh,caddy-cloudflare.sh} . && cp src/hub/deploy/env.example .env
chmod +x update.sh caddy-cloudflare.sh && chmod 600 .env   # then fill .env in
docker compose up -d --build
./caddy-cloudflare.sh                                       # adds the universe.cashegg.com block to /etc/caddy/Caddyfile and reloads
```

Every later release: `./update.sh`.

## Cloudflare

The DNS record for the hub can be proxied through Cloudflare (orange cloud) or not (grey cloud). Either way Caddy gets
its own certificate from Let's Encrypt (the HTTP challenge passes through Cloudflare).

Proxied, two things matter. Caddy must know the visitor's address: `caddy-cloudflare.sh` lists Cloudflare's ranges as
trusted proxies and hands the hub a single `X-Forwarded-For` entry, Caddy's own `{client_ip}`, which is the address
Cloudflare reports when the call came through Cloudflare and the peer itself otherwise, so a visitor who reaches the
server directly cannot name their own address. And **Cloudflare must not challenge the hub's visitors**: a JavaScript
challenge (Bot Fight Mode, "Under Attack", a managed challenge rule) stops every Mac, since the panel talks to the hub
with plain HTTP calls that cannot solve one. Add a WAF rule that skips challenges for the hub's hostname, or take the
record off the proxy. The hub has its own rate limits, so it does not need Cloudflare's.

## Backup

The whole hub is the one database in the `hub-data` volume; `hub/README.md` says how to copy it.
