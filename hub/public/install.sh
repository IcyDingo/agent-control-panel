#!/bin/sh
# Installs the Agent Panel worker on a Mac: checks what it needs, downloads the signed release the hub names from GitHub
# into ~/Library/Application Support/Agent Panel/worker, writes the launcher (run.sh) that launchd runs, installs the
# background service through it and signs the Mac in to the hub. The worker then updates itself once a day. Run it
# again to repair an install. The line runs this file as it is on GitHub's main, so the hub is not trusted with the
# script itself (the hub serves the same file at /install too). The Download page links to it, to read before it runs:
#   curl -fsSL https://raw.githubusercontent.com/IcyDingo/agent-control-panel/main/hub/public/install.sh | sh -s -- [flags]
#   --link <code>   sign in with a code already approved on the website, instead of the usual sign-in
#   --no-update     install with the daily self-update turned off
#   --uninstall     remove the service and the worker; your sign-in and your galaxy's record stay
#   --help          print the usage
# ACP_HUB names another hub (default https://universe.cashegg.com).
set -u

HUB="${ACP_HUB:-https://universe.cashegg.com}"
REPO=IcyDingo/agent-control-panel
SCRIPT_URL="https://raw.githubusercontent.com/$REPO/main/hub/public/install.sh"
SUPPORT="$HOME/Library/Application Support/Agent Panel"
DIR="$SUPPORT/worker"
PLIST="$HOME/Library/LaunchAgents/local.agent-panel.plist"
LOG="$HOME/Library/Logs/Agent Panel/daemon-4747.log"
USAGE="usage: curl -fsSL $SCRIPT_URL | sh -s -- [--link <code>] [--no-update] [--uninstall]"

missing=0
paint() { if [ -t 1 ]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi; }
ok() { printf '  %s %s\n' "$(paint 32 ✓)" "$1"; }
warn() { printf '  %s %s\n' "$(paint 33 !)" "$1"; }
fail() { printf '  %s %s\n' "$(paint 31 ✗)" "$1"; missing=1; }
at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
usage_error() { printf '%s\n' "$USAGE" >&2; exit 2; }

# Everything runs from main, called on the last line, so a download cut off mid-transfer under `curl | sh` runs nothing.
main() {
  link=
  update=1
  uninstall=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --link) case "${2-}" in ''|--*) usage_error ;; esac; link="$2"; shift ;;
      --no-update) update=0 ;;
      --uninstall) uninstall=1 ;;
      --help) printf '%s\n' "$USAGE"; exit 0 ;;
      *) usage_error ;;
    esac
    shift
  done

  if [ "$uninstall" = 1 ]; then
    # The service is removed only when it runs this worker (the app's install runs it from a clone, and that stays);
    # when daemon remove can't run or fails, launchd is told directly, so no job is left to respawn without run.sh.
    if [ -f "$PLIST" ] && grep -qF "$DIR/run.sh" "$PLIST"; then
      if ! { [ -f "$DIR/current/server.mjs" ] && command -v node >/dev/null 2>&1 &&
        node "$DIR/current/server.mjs" daemon remove; }; then
        launchctl bootout "gui/$(id -u)/local.agent-panel" 2>/dev/null
        rm -f "$PLIST"
      fi
    elif [ -f "$PLIST" ]; then
      printf '%s\n' "The background service runs from elsewhere (the app's install); it was left in place."
    fi
    rm -rf "$DIR"
    printf '%s\n' "Removed the worker."
    printf '%s\n' "Still here, in case you come back: \"$SUPPORT/hub.json\" (your sign-in), \"$SUPPORT/world\" (your galaxy's record) and ~/Library/Logs/Agent Panel. To remove them too: rm -rf \"$SUPPORT\" ~/Library/Logs/\"Agent Panel\""
    exit 0
  fi

  [ "$(uname)" = Darwin ] || { printf '%s\n' "The worker runs on macOS only." >&2; exit 1; }
  printf '%s\n' "Checking what the worker needs:"

  macos="$(sw_vers -productVersion)"
  if at_least "$macos" 14; then ok "macOS $macos"; else fail "macOS $macos: the worker needs macOS 14 or newer"; fi

  node_path=
  v=0
  if command -v node >/dev/null 2>&1; then
    node_path="$(command -v node)"
    v="$(node -p process.versions.node 2>/dev/null || printf 0)"
  fi
  if [ -n "$node_path" ] && at_least "$v" 20; then ok "Node $v"
  else fail "Node: Install Node from nodejs.org (the LTS installer), then run the line again."; fi

  # The worker reads commits with git, which comes with Apple's Command Line Tools; tokens count without it.
  if xcode-select -p >/dev/null 2>&1; then ok "Apple's Command Line Tools"
  else warn "Apple's Command Line Tools: Commits won't count until you run  xcode-select --install ; tokens count from now."; fi

  if command -v claude >/dev/null 2>&1; then ok "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"
  else warn "Claude Code isn't installed yet; your galaxy grows once it is used."; fi

  if [ "$missing" = 1 ]; then
    printf '\n%s\n' "Fix the ✗ lines above, then run the line again."
    exit 1
  fi

  # The hub names the release, but GitHub vouches for it: the commit must be on main, it is downloaded from GitHub by
  # that commit (never from an address the hub gives), and the signature is checked with the keys in that commit
  # before anything is put in place. A hub that was taken over can name only a signed release from main.
  release="$(curl -fsSL "$HUB/api/release")"
  sha="$(printf '%s\n' "$release" | sed -n 's/.*"sha":"\([0-9a-f]\{40\}\)".*/\1/p')"
  n="$(printf '%s\n' "$release" | sed -n 's/.*"n":\([1-9][0-9]\{0,9\}\)[,}].*/\1/p')"
  sigs="$(printf '%s\n' "$release" | sed -n 's/.*"sigs":\[\([^]]*\)\].*/\1/p' | tr -d '"')"
  if [ -z "$sha" ]; then
    fail "The hub did not name a release (is $HUB reachable?)."
    exit 1
  fi
  short="$(printf '%s' "$sha" | cut -c1-7)"
  case "$n:$sigs" in :*|*:|*[!0-9A-Za-z_,:-]*)
    fail "The hub's release $short is not signed, so it is not installed."
    exit 1 ;;
  esac
  # GitHub's compare of main with the commit says `identical` or `behind` when main holds it. Without -L: a redirect
  # (a renamed repository) is not followed. Whitespace is dropped so the top-level status is found however it is laid out.
  status="$(curl -fsS -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/compare/main...$sha" 2>/dev/null |
    tr -d ' \t\r\n' | sed -n 's/.*"status":"\([a-z]*\)","ahead_by".*/\1/p')"
  case "$status" in
    identical|behind) ;;
    '') fail "GitHub could not be asked whether release $short is on main; run the line again in a minute."; exit 1 ;;
    *) fail "Release $short is not on main, so it is not installed."; exit 1 ;;
  esac
  url="https://codeload.github.com/$REPO/tar.gz/$sha"
  printf '\n%s\n' "Getting the worker (release $short)…"

  # Unpacked and its launcher written beside the live files first, so a broken download changes nothing that runs.
  # The node path goes into a sed replacement, where |, & and \ mean something; escaped, any path works.
  mkdir -p "$DIR"
  tmp="$DIR/$sha.tmp"
  rm -rf "$tmp"; mkdir "$tmp"
  node_sed="$(printf '%s\n' "$node_path" | sed 's/[|&\\]/\\&/g')"
  if ! { curl -fsSL "$url" -o "$DIR/$sha.tgz" && tar -xzf "$DIR/$sha.tgz" -C "$tmp" &&
    [ -f "$tmp/agent-control-panel-$sha/launcher.sh" ] &&
    sed "s|__NODE__|$node_sed|" "$tmp/agent-control-panel-$sha/launcher.sh" > "$DIR/run.sh.new"; }; then
    fail "The archive did not look like the release."
    rm -rf "$tmp" "$DIR/$sha.tgz" "$DIR/run.sh.new"
    exit 1
  fi
  # The commit is on main, so its own key list is the owner's; the signature must match one of those keys.
  if ! { [ -f "$tmp/agent-control-panel-$sha/release-keys.mjs" ] &&
    node "$tmp/agent-control-panel-$sha/release-keys.mjs" verify "$sha" "$n" "$sigs"; }; then
    fail "Release $short is not signed by a known key, so it is not installed."
    rm -rf "$tmp" "$DIR/$sha.tgz" "$DIR/run.sh.new"
    exit 1
  fi
  rm -rf "$DIR/$sha"; mv "$tmp/agent-control-panel-$sha" "$DIR/$sha"; rm -rf "$tmp" "$DIR/$sha.tgz"
  chmod 755 "$DIR/run.sh.new"
  mv -f "$DIR/run.sh.new" "$DIR/run.sh"
  ln -sfn "$DIR/$sha" "$DIR/current"
  # A fresh install starts clean: no switch for the launcher, and no release number or last check from an earlier install.
  rm -f "$DIR/switch" "$DIR/release" "$DIR/last-check"
  [ "$update" = 1 ] || printf '{ "auto": false }\n' > "$DIR/update.json"

  # The app installer's service runs the panel from a clone; installing here points the same service at run.sh.
  takeover=0
  if [ -f "$PLIST" ] && ! grep -qF "$DIR/run.sh" "$PLIST"; then takeover=1; fi
  printf '\n%s\n' "Installing the background service:"
  ACP_NODE="$node_path" node "$DIR/current/server.mjs" daemon install --program "$DIR/run.sh" ||
    { fail "The background service didn't install (see the line above); run the line again to retry."; exit 1; }
  [ "$takeover" = 0 ] || warn "A background service already runs from another folder; it now runs from the worker install and updates itself. The app keeps working with it."
  answered=0
  i=0
  while [ "$i" -lt 20 ]; do
    if curl -fsS --max-time 0.4 http://127.0.0.1:4747/ >/dev/null 2>&1; then answered=1; break; fi
    sleep 0.5
    i=$((i + 1))
  done
  if [ "$answered" = 1 ]; then ok "The worker is running"
  else warn "The worker hasn't answered yet; its log is $LOG"; fi

  printf '\n%s\n' "Signing in to $HUB:"
  if [ -n "$link" ]; then node "$DIR/current/server.mjs" login --link "$link"; else node "$DIR/current/server.mjs" login; fi ||
    { fail "The worker is installed but this Mac isn't signed in. Run the line again; with --link, get a new code from the website first."; exit 1; }

  printf '\n%s\n' "Done. The worker runs in the background from now on, also after a restart, and your galaxy grows from your agents'
work. See it at $HUB/@you (the sign-in above printed the address)."
  [ "$update" = 0 ] || printf '%s\n' "The worker checks $HUB for a new release once a day and updates itself; to turn that off:   printf '{ \"auto\": false }\\n' > \"$DIR/update.json\""
  cat <<EOF
To remove the worker (sign out first with  node "$DIR/current/server.mjs" logout  so the hub forgets this Mac):   curl -fsSL $SCRIPT_URL | sh -s -- --uninstall
Want the session board too? $HUB/download has the app.
EOF
}

main "$@"
