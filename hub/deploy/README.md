# How the Universe is deployed

The hub runs on one server behind Caddy, as a container built from a clone of this repository. These files are what
sits in `/srv/agent-hub` there; nothing in them is secret.

```
/srv/agent-hub
  src/                  git clone of this repository (main)
  compose.yml           builds hub/Dockerfile from src and runs it on 127.0.0.1:4848, database in the hub-data volume
  .env                  the settings, from env.example (the GitHub id and secret live only here, mode 600)
  update.sh             deploy the signed release tools/release.mjs sign names (verifies first, never a lower number); plain, it pulls main until the first signed release
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

A release is the signed one that `tools/release.mjs sign` names, and `update.sh` checks the signature before it fetches,
builds or writes anything. `hub/README.md` says how the key is made and a release is signed. `update.sh` writes
`release.env` with the commit, its number and the signatures; the hub serves them at `/api/release`, and that is the
version every worker installs and updates to. Until the first signed release, a plain `./update.sh` still pulls `main`.

The first signed deploy. The server still has the `update.sh` it was set up with, which knows nothing of signatures, so
copy the new one from the repository first. Before that, the maintainer's public key must be in `release-keys.mjs` on
`main` (a pull request, merged), because a hub with no key to check against serves no release. On the server:

```sh
cd /srv/agent-hub
git -C src fetch -q origin main && git -C src show origin/main:hub/deploy/update.sh > update.sh && chmod +x update.sh
```

A `compose.yml` from before the one-line install needs the same copy, with `compose.yml` in place of `update.sh` in that
command, so that it reads `release.env`.

Then, on the Mac, run `git pull` on `main` and `node tools/release.mjs sign`. It prints the ssh line; run it, exactly as
printed. Until this deploy, workers still accept an unsigned release. After it, every worker checks the signature within
a day and installs nothing the key did not sign.

Every later release is the same two steps on the Mac, nothing to copy on the server:

```sh
node tools/release.mjs sign                        # prints  ssh root@<host> /srv/agent-hub/update.sh <sha> <n> <sigs>
node tools/release.mjs sign --deploy root@<host>   # signs and runs that line
```

Once `release.env` holds a signature, a plain `./update.sh` is refused, so nothing unsigned can replace the release:

```
This hub serves signed releases: run  node tools/release.mjs sign  on your Mac and use the line it prints.
```

`update.sh` refuses, before it fetches, builds or writes anything, a release no known key signed (`Release 1a2b3c4 is
not signed by a known key.`) and a number that is not above the one in `release.env`, so an old signed line cannot be
replayed to go back. The number
counts as used as soon as it is written to `release.env`: if the build or the start fails after that, make a new commit
and `sign` again.

Then edit the "Universe API" rule as the Cloudflare section below says, so `/install` skips the bot check too, and
check both from outside the server:

```sh
curl -fsSL https://universe.cashegg.com/api/release            # {"ok":true,"sha":"…","n":…,"sigs":["…"],"url":"…"}
curl -fsSL https://universe.cashegg.com/install | head -1      # #!/bin/sh
```

## A deploy-only key (optional)

`--deploy` runs ssh as you, so it uses the key that can do anything on the server. To let it do one thing only, make a
second ssh key on the Mac (`ssh-keygen -t ed25519 -f ~/.ssh/acp-deploy`), give it a name in `~/.ssh/config` with
`IdentityFile ~/.ssh/acp-deploy` and `IdentitiesOnly yes`, and deploy with `--deploy <that name>`. On the server, save
this as `/srv/agent-hub/deploy-only.sh` and `chmod +x` it:

```sh
#!/bin/sh
rest=${SSH_ORIGINAL_COMMAND#/srv/agent-hub/update.sh }
case $rest in *[!0-9A-Za-z_,\ -]*) rest= ;; esac
if printf '%s\n' "$rest" | grep -Eq '^[0-9a-f]{40} [1-9][0-9]* [A-Za-z0-9_,-]+$'; then
  exec /srv/agent-hub/update.sh $rest   # unquoted on purpose: the three fields split
fi
printf 'deploy key: only  update.sh <sha> <n> <sigs>  is allowed.\n' >&2; exit 1
```

Then add the key's public half to `/root/.ssh/authorized_keys` as a line that starts like this, followed by the
`ssh-ed25519 AAAA…` key itself:

```
command="/srv/agent-hub/deploy-only.sh",no-port-forwarding,no-pty,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… acp-deploy
```

That key can deploy and nothing else: whatever it asks to run, the server runs `deploy-only.sh`, which accepts only
`update.sh` with a commit, a number and signatures, and `update.sh` still verifies them. Your admin key stays as it is.

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
