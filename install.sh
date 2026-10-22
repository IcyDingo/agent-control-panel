#!/bin/bash
# Checks what the agent panel needs, builds Agent Panel.app into ~/Applications (app/build.sh) and installs the
# background service that keeps the panel running (node server.mjs daemon install). Run it again after a git pull, or
# when node or claude moves: it rebuilds the app and restarts the service. AGENT_PANEL_APP and ACP_PORT pass through
# to app/build.sh.
#   --no-daemon   build the app, install no service
#   --uninstall   remove the service and the app
set -euo pipefail
cd "$(dirname "$0")"

USAGE="usage: ./install.sh [--no-daemon | --uninstall]"
daemon=1
uninstall=0
for arg in "$@"; do
  case "$arg" in
    --no-daemon) daemon=0 ;;
    --uninstall) uninstall=1 ;;
    --help) echo "$USAGE"; exit 0 ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done

port="${ACP_PORT:-4747}"
out="${AGENT_PANEL_APP:-$HOME/Applications/Agent Panel.app}"
shown="${out/#$HOME/~}"

if (( uninstall )); then
  label="local.agent-panel"
  [[ "$port" == 4747 ]] || label="$label.$port"
  if command -v node >/dev/null; then
    node server.mjs daemon remove
  else
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$label.plist"
    echo "Background service removed"
  fi
  rm -rf "$out"
  echo "Removed $shown"
  cat <<EOF

Two things are left for you to remove:
  - the hook entries that point at 127.0.0.1:$port, in each profile's settings.json
  - ~/Library/Application Support/Agent Panel and ~/Library/Logs/Agent Panel
EOF
  exit 0
fi

MIN_CLAUDE=2.1.303 # claude agents --json, --bg and claude attach, as the panel uses them
missing=0
paint() { if [[ -t 1 ]]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi; }
ok() { printf '  %s %s\n' "$(paint 32 ✓)" "$1"; }
warn() { printf '  %s %s\n' "$(paint 33 !)" "$1"; }
fail() { printf '  %s %s\n' "$(paint 31 ✗)" "$1"; missing=1; }
at_least() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

[[ "$(uname)" == Darwin ]] || { echo "The agent panel runs on macOS only." >&2; exit 1; }
echo "Checking what the agent panel needs:"

macos="$(sw_vers -productVersion)"
if at_least "$macos" 14; then ok "macOS $macos"; else fail "macOS $macos: the app needs macOS 14 or newer"; fi

# swiftc builds the app; python3 runs the helpers that work a background session's screen. Both come with Apple's
# Command Line Tools, and until those are installed /usr/bin/swiftc and /usr/bin/python3 only offer to install them.
if dev="$(xcode-select -p 2>/dev/null)" && [[ -d "$dev" ]]; then ok "Apple's Command Line Tools ($dev)"
else fail "Apple's Command Line Tools: run  xcode-select --install  (Xcode itself isn't needed)"; fi

if command -v node >/dev/null; then
  v="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
  if at_least "$v" 20; then ok "Node $v"; else fail "Node $v: the panel needs Node 20 or newer (brew install node, or nodejs.org)"; fi
else fail "Node: install Node 20 or newer (brew install node, or the installer from nodejs.org)"; fi

if command -v claude >/dev/null; then
  cv="$(claude --version 2>/dev/null | awk '{print $1}')"
  if at_least "${cv:-0}" "$MIN_CLAUDE"; then ok "Claude Code $cv"
  else fail "Claude Code ${cv:-?}: the panel needs $MIN_CLAUDE or newer (claude update)"; fi
  if claude agents --json --all >/dev/null 2>&1; then ok "claude agents answers (the board reads it)"
  else warn "claude agents --json didn't answer: the board lists sessions from it, so the panel will show none"; fi
else fail "Claude Code: install it (https://code.claude.com), then run this again"; fi

if (( missing )); then
  echo
  echo "Fix the ✗ lines above, then run ./install.sh again."
  exit 1
fi

echo
echo "Building the app:"
app/build.sh

if (( daemon )); then
  echo
  echo "Installing the background service:"
  ACP_NODE="$(command -v node)" node server.mjs daemon install ||
    { fail "The background service didn't install (see the line above). The app still works; run ./install.sh again to retry."; exit 1; }
  answered=0
  for _ in $(seq 20); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/" >/dev/null 2>&1; then answered=1; break; fi
    sleep 0.5
  done
  if (( answered )); then ok "The panel is running and World has started"
  else warn "The service hasn't answered yet; its log is ~/Library/Logs/Agent Panel/daemon-$port.log"; fi

  cat <<EOF

Done. The panel runs in the background from now on, also after a restart, and World grows from your sessions whether
or not you open it. Next:
  1. Open Agent Panel ($shown, or Spotlight). macOS may ask whether it may use your Documents folder:
     the panel reads the repositories your sessions work in.
  2. If you use more than one Claude Code profile, pick yours under Profile, top right.
  3. Click Connect this profile. Sessions you start after that show up on the board.

Keep this folder where it is: the service runs the panel from here. After a git pull, run ./install.sh again: it
restarts the service on the new code (requests the panel was holding go back to their terminals for a moment).
./install.sh --no-daemon skips the service; ./install.sh --uninstall removes it and the app.
EOF
else
  cat <<EOF

Done. Next:
  1. Open Agent Panel ($shown, or Spotlight). macOS may ask whether it may use your Documents folder:
     the panel reads the repositories your sessions work in.
  2. If you use more than one Claude Code profile, pick yours under Profile, top right.
  3. Click Connect this profile. Sessions you start after that show up on the board.

Keep this folder where it is: the app runs the panel from here. After a git pull, run ./install.sh again, then quit
the app (⌘Q) and open it again.
EOF
fi

if [[ -t 0 && -t 1 ]]; then
  read -r -p "Open it now? [Y/n] " answer
  [[ "$answer" =~ ^[Nn] ]] || open "$out"
fi
