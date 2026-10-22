#!/bin/sh
# Update the hub to the latest main: pull, rebuild, restart. Run from /srv/agent-hub (also after editing .env).
set -e
cd "$(dirname "$0")"
git -C src pull -q --ff-only
# The hub serves this commit at /api/release; it is the version every worker installs and updates to.
printf 'HUB_RELEASE=%s\n' "$(git -C src rev-parse HEAD)" > release.env
docker compose build -q
docker compose up -d
sleep 2
# The hub answers only to its own hostname; this asks it the way Caddy does.
curl -sf -H 'Host: universe.cashegg.com' http://127.0.0.1:4848/healthz && echo
