#!/bin/sh
# Update the hub: fetch the code, rebuild, restart. Run from /srv/agent-hub (also after editing .env).
#
# A signed release is deployed with `update.sh <sha> <n> <sigs>`, the line `node tools/release.mjs sign` prints on
# the owner's Mac. The script first checks that a known key signed "<n> <sha>", then checks out exactly that commit,
# builds it, writes the release, the number and the signatures to release.env, and restarts. The hub serves the
# release only when those three still verify. Three cases:
#
# - The first signed deploy: release.env has no number yet, so any number is above it. Until then a plain
#   `update.sh` pulls the latest main and serves it unsigned.
# - A new release: its number must be above the one in release.env, so an old signed line cannot be replayed to take
#   the hub back. The release on record is the one exception: its own line (the same number and sha) is verified and
#   deployed again, so a deploy whose start failed can simply be run again.
# - A restart, after editing .env: a plain `update.sh` once release.env holds a signature. It fetches, checks out and
#   writes nothing; it rebuilds and restarts the release on record. Nothing unsigned can replace a signed release.
#
# Every refusal happens before anything is fetched, built or written. release.env is put in place only after the
# build succeeds, so a failed build leaves the release on record as it was and the same line can be run again.
set -e
cd "$(dirname "$0")"

refuse() { printf '%s\n' "$1" >&2; exit 1; }

if [ "$#" -ne 0 ] && [ "$#" -ne 3 ]; then
  echo 'usage: update.sh [<sha> <n> <sigs>]' >&2
  exit 2
fi

# One line of the release now deployed, from release.env (HUB_RELEASE or HUB_RELEASE_N); empty when there is none.
deployed() { if [ -f release.env ]; then sed -n "s/^$1=//p" release.env | tail -n 1; fi; }

# signed: the hub serves a signed release after this run, so /api/release is checked. restart: nothing new is deployed.
signed=1
restart=
if [ "$#" -eq 0 ]; then
  if [ -f release.env ] && grep -q '^HUB_RELEASE_SIG=' release.env; then
    # A signed release is deployed: rebuild and restart it as it is, without a fetch, a checkout or a write.
    restart=1
    sha=$(deployed HUB_RELEASE)
    n=$(deployed HUB_RELEASE_N)
    short=$(printf '%s' "$sha" | cut -c1-7)
    # A signed deploy whose build failed leaves src on its commit while release.env keeps the one before; a restart
    # builds src, so it must hold the release on record.
    [ "$(git -C src rev-parse HEAD)" = "$sha" ] \
      || refuse "The checkout in src is not release $short, the one on record; deploy with a signed line instead."
  else
    # A signed deploy leaves src on a detached commit, so go back to main first.
    git -C src checkout -q main
    git -C src pull -q --ff-only
    # The hub serves this commit at /api/release; it is the version every worker installs and updates to.
    printf 'HUB_RELEASE=%s\n' "$(git -C src rev-parse HEAD)" > release.env.new
    signed=
  fi
else
  sha=$1
  n=$2
  sigs=$3
  short=$(printf '%s' "$sha" | cut -c1-7)

  case "$sha" in *[!0-9a-f]*) refuse 'update.sh: sha is not valid.' ;; esac
  [ "${#sha}" -eq 40 ] || refuse 'update.sh: sha is not valid.'
  case "$n" in ''|0*|*[!0-9]*) refuse 'update.sh: n is not valid.' ;; esac
  [ "${#n}" -le 10 ] || refuse 'update.sh: n is not valid.'
  # Signatures are base64url joined with commas; anything else could not be one, and must not reach release.env.
  case "$sigs" in ''|*[!A-Za-z0-9_,-]*) refuse 'update.sh: sigs is not valid.' ;; esac

  # The number of the release now deployed. A missing line or an empty value (a release.env from a plain deploy)
  # means no floor; any other value that is not a plain number is refused, so a hand edit cannot lift the floor.
  m=$(deployed HUB_RELEASE_N)
  if [ -z "$m" ]; then
    m=0
  else
    case "$m" in 0*|*[!0-9]*) refuse 'release.env has an unreadable HUB_RELEASE_N; fix it by hand before deploying.' ;; esac
    [ "${#m}" -le 10 ] || refuse 'release.env has an unreadable HUB_RELEASE_N; fix it by hand before deploying.'
  fi
  # The same release again is deployed again (after a start that failed, say); any other at or below m is refused.
  if [ "$n" -lt "$m" ] || { [ "$n" -eq "$m" ] && [ "$sha" != "$(deployed HUB_RELEASE)" ]; }; then
    refuse "Release $short (number $n) is not newer than the one deployed ($m)."
  fi

  # Verify inside the node image (without a network), since the server may have no node. The check is skipped only
  # on the bootstrap deploy: release.env carries no signature yet and src/release-keys.mjs does not exist yet. Once
  # a signature is there the file must be too; the hub still refuses an unsigned release at /api/release below.
  if [ -f src/release-keys.mjs ]; then
    docker run --rm --network none -v "$PWD/src/release-keys.mjs:/k.mjs:ro" node:22-alpine node /k.mjs verify "$sha" "$n" "$sigs" \
      || refuse "Release $short is not signed by a known key."
  elif [ -f release.env ] && grep -q '^HUB_RELEASE_SIG=' release.env; then
    refuse 'src/release-keys.mjs is missing; the checkout is damaged.'
  fi

  git -C src fetch -q origin
  git -C src checkout -q --detach "$sha"
  printf 'HUB_RELEASE=%s\nHUB_RELEASE_N=%s\nHUB_RELEASE_SIG=%s\n' "$sha" "$n" "$sigs" > release.env.new
fi

docker compose build -q
# The hub runs as the image's node user. A database volume made while it still ran as root is handed to that user
# once; after that /data is node's and this changes nothing.
docker compose run --rm --no-deps -T --user root --cap-add CHOWN --entrypoint sh hub \
  -c '[ "$(stat -c %U /data)" = node ] || chown -R node:node /data'
# Only a build that succeeded puts the new release on record; the container reads release.env when it starts.
[ -n "$restart" ] || mv -f release.env.new release.env
docker compose up -d
sleep 2
# The hub answers only to its own hostname; this asks it the way Caddy does.
curl -sf -H 'Host: universe.cashegg.com' http://127.0.0.1:4848/healthz || refuse 'The hub did not answer /healthz after the restart.'
echo
# A plain deploy carries no signature, so the hub has no release to show; only a signed one is asked for it.
if [ -n "$signed" ]; then
  curl -sf -H 'Host: universe.cashegg.com' http://127.0.0.1:4848/api/release >/dev/null \
    || refuse "The hub refuses this release; check release.env and the hub's log."
  if [ -n "$restart" ]; then
    echo "Restarted release $short (number $n); to deploy a new one, run  node tools/release.mjs sign  on your Mac."
  else
    echo "Deployed release $short (number $n)."
  fi
fi
