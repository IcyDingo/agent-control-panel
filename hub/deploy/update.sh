#!/bin/sh
# Update the hub: fetch the code, rebuild, restart. Run from /srv/agent-hub (also after editing .env).
#
# Plain mode, `update.sh`: pull the latest main and serve it. This works only until the first signed release.
#
# Signed mode, `update.sh <sha> <n> <sigs>`: the line `node tools/release.mjs sign` prints on the owner's Mac.
# The script first checks that a known key signed "<n> <sha>", then checks out exactly that commit, writes the
# release, the number and the signatures to release.env, and restarts. The hub serves the release only when
# those three still verify. Once release.env holds a signature, a plain deploy is refused, so nothing unsigned
# can replace a signed release.
#
# The hub never goes back to a lower number: a signed deploy whose number is not above the one in release.env
# is refused, so an old signed line cannot be replayed to downgrade the hub.
#
# Every refusal happens before anything is fetched, built or written.
#
# Once release.env is written the number counts as used: if the build or the start fails after that, the next
# attempt must be signed with a higher number, which means a new commit.
set -e
cd "$(dirname "$0")"

refuse() { printf '%s\n' "$1" >&2; exit 1; }

if [ "$#" -ne 0 ] && [ "$#" -ne 3 ]; then
  echo 'usage: update.sh [<sha> <n> <sigs>]' >&2
  exit 2
fi

if [ "$#" -eq 0 ]; then
  if [ -f release.env ] && grep -q '^HUB_RELEASE_SIG=' release.env; then
    refuse 'This hub serves signed releases: run  node tools/release.mjs sign  on your Mac and use the line it prints.'
  fi
  # A signed deploy leaves src on a detached commit, so go back to main first.
  git -C src checkout -q main
  git -C src pull -q --ff-only
  # The hub serves this commit at /api/release; it is the version every worker installs and updates to.
  printf 'HUB_RELEASE=%s\n' "$(git -C src rev-parse HEAD)" > release.env.new
  mv -f release.env.new release.env
  n=
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
  m=
  if [ -f release.env ]; then
    m=$(sed -n 's/^HUB_RELEASE_N=//p' release.env | tail -n 1)
  fi
  if [ -z "$m" ]; then
    m=0
  else
    case "$m" in 0*|*[!0-9]*) refuse 'release.env has an unreadable HUB_RELEASE_N; fix it by hand before deploying.' ;; esac
    [ "${#m}" -le 10 ] || refuse 'release.env has an unreadable HUB_RELEASE_N; fix it by hand before deploying.'
  fi
  if [ "$n" -le "$m" ]; then
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
  mv -f release.env.new release.env
fi

docker compose build -q
docker compose up -d
sleep 2
# The hub answers only to its own hostname; this asks it the way Caddy does.
curl -sf -H 'Host: universe.cashegg.com' http://127.0.0.1:4848/healthz || refuse 'The hub did not answer /healthz after the restart.'
echo
# A plain deploy carries no signature, so the hub has no release to show; only a signed one is asked for it.
if [ -n "$n" ]; then
  curl -sf -H 'Host: universe.cashegg.com' http://127.0.0.1:4848/api/release >/dev/null \
    || refuse "The hub refuses this release; check release.env and the hub's log."
  echo "Deployed release $short (number $n)."
fi
