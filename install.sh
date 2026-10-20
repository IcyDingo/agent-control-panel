#!/bin/bash
# Checks what the agent panel needs, then builds Agent Panel.app into ~/Applications (app/build.sh). Run it again after
# a git pull, or when node or claude moves: it rebuilds the app and changes nothing else. AGENT_PANEL_APP and ACP_PORT
# pass through to app/build.sh.
set -euo pipefail
cd "$(dirname "$0")"

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
out="${AGENT_PANEL_APP:-$HOME/Applications/Agent Panel.app}"
shown="${out/#$HOME/~}"

cat <<EOF

Done. Next:
  1. Open Agent Panel ($shown, or Spotlight). macOS may ask whether it may use your Documents folder:
     the panel reads the repositories your sessions work in.
  2. If you use more than one Claude Code profile, pick yours under Profile, top right.
  3. Click Connect this profile. Sessions you start after that show up on the board.

Keep this folder where it is: the app runs the panel from here. After a git pull, run ./install.sh again, then quit
the app (⌘Q) and open it again.
EOF

if [[ -t 0 && -t 1 ]]; then
  read -r -p "Open it now? [Y/n] " answer
  [[ "$answer" =~ ^[Nn] ]] || open "$out"
fi
