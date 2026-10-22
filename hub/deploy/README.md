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
  firewall-cloudflare.sh, cloudflare-only.{service,timer}
                        the firewall: only Cloudflare reaches the web ports (see below)
```

First time:

```sh
mkdir -p /srv/agent-hub && cd /srv/agent-hub
git clone --depth 1 https://github.com/IcyDingo/agent-control-panel src
cp src/hub/deploy/{compose.yml,update.sh,caddy-cloudflare.sh} . && cp src/hub/deploy/env.example .env
chmod +x update.sh caddy-cloudflare.sh && chmod 600 .env   # then fill .env in
./update.sh                                                 # pulls, writes release.env, builds and starts the hub
./caddy-cloudflare.sh                                       # adds the universe.cashegg.com block to /etc/caddy/Caddyfile and reloads
```

Every later release: `./update.sh`. It also writes `release.env` with the commit it deployed, which the hub serves at `/api/release`: that is the version every worker installs and updates to.

Upgrading an existing deploy: `compose.yml` and `update.sh` were copied into `/srv/agent-hub` once, at the first
deploy, so one from before the one-line install runs the old `update.sh`, which writes no `release.env`; `/api/release`
then answers 503 and the line stops at "The hub did not name a release". Copy both again from the pulled clone and run
it:

```sh
git -C src pull -q --ff-only && cp src/hub/deploy/{compose.yml,update.sh} . && ./update.sh
```

Then edit the "Universe API" rule as the Cloudflare section below says, so `/install` skips the bot check too, and
check both from outside the server:

```sh
curl -fsSL https://universe.cashegg.com/api/release            # {"ok":true,"sha":"…","url":"…"}
curl -fsSL https://universe.cashegg.com/install | head -1      # #!/bin/sh
```

## Cloudflare

The DNS record for the hub can be proxied through Cloudflare (orange cloud) or not (grey cloud). Either way Caddy gets
its own certificate from Let's Encrypt (the HTTP challenge passes through Cloudflare).

As deployed, the record is proxied and the zone is on the Pro plan with Super Bot Fight Mode on. One WAF custom rule,
"Universe API", lets the Macs through while the pages keep the bot check:

```
(http.host eq "universe.cashegg.com" and (starts_with(http.request.uri.path, "/api/") or http.request.uri.path in {"/install" "/install.sh"}))
```

Action Skip, with Super Bot Fight Mode (and rate limiting) ticked and "All remaining custom rules" left unticked (the
form refuses the two together). Everything a Mac calls is under `/api/`; the sign-in and the device approval are
browser pages and stay protected. `/install` is fetched by `curl`, which the bot check would otherwise challenge; the rule is edited in the Cloudflare dashboard, not by any script here. On the free plan the same product is Bot Fight Mode, which no rule can skip: there it
must be off for the zone.

Proxied, two things matter. Caddy must know the visitor's address: `caddy-cloudflare.sh` lists Cloudflare's ranges as
trusted proxies, takes the address from Cloudflare's own `CF-Connecting-IP` header (never from an `X-Forwarded-For`
the visitor could have sent along, and only on connections that really come from Cloudflare), and hands the hub that
one address as the single `X-Forwarded-For` entry. A visitor who reaches the server directly is their peer address,
whatever headers they send. And **Cloudflare must not challenge the hub's visitors**: a JavaScript
challenge (Bot Fight Mode, "Under Attack", a managed challenge rule) stops every Mac, since the panel talks to the hub
with plain HTTP calls that cannot solve one. Add a WAF rule that skips challenges for the hub's hostname, or take the
record off the proxy. The hub has its own rate limits, so it does not need Cloudflare's.

## Firewall

With the record proxied, Cloudflare hides the server's address, and the firewall makes knowing it useless.
`firewall-cloudflare.sh` writes one nftables table of its own, `cloudflare_only`, and applies it: ports 80 and 443
accept connections from Cloudflare's ranges and loopback and drop everything else; the containers' host ports (3000,
3001, anything Docker publishes) are unreachable from outside, both as host ports and as forwarded ones; SSH and the
rest are untouched. Docker's own tables are left alone, so it keeps working across its restarts. The ranges come from
cloudflare.com/ips; when they cannot be fetched the last written file is applied again.

```sh
cp src/hub/deploy/{firewall-cloudflare.sh,cloudflare-only.service,cloudflare-only.timer} .
chmod +x firewall-cloudflare.sh && ./firewall-cloudflare.sh
cp cloudflare-only.service cloudflare-only.timer /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now cloudflare-only.service cloudflare-only.timer   # at boot after Docker, and a weekly refresh
```

Check it: from outside, `curl --max-time 8 http://<server ip>/` times out, while the site answers through Cloudflare.
If a record on this server ever goes grey cloud (DNS only), that site stops answering until the firewall is removed
(`nft delete table inet cloudflare_only` and disable the unit), because its visitors no longer come from Cloudflare.

## Backup

The whole hub is the one database in the `hub-data` volume; `hub/README.md` says how to copy it.
