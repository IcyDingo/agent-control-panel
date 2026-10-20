#!/bin/bash
# Builds Agent Panel.app (default ~/Applications/Agent Panel.app): the panel in its own window, with a Dock badge.
# It bakes in this repo's path, node's path, this shell's PATH and the port, because an app opened from the Dock gets no
# shell environment. Run it again if node, claude or the repo moves.
#   AGENT_PANEL_APP=<path>.app   build somewhere else
#   ACP_PORT=<port>              a panel on another port (a separate app, with its own bundle id)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
out="${AGENT_PANEL_APP:-$HOME/Applications/Agent Panel.app}"
port="${ACP_PORT:-4747}"
id="local.agent-panel"
[[ "$port" == 4747 ]] || id="$id.$port"

[[ "$out" == *.app ]] || { echo "AGENT_PANEL_APP must end in .app" >&2; exit 1; }
node="$(command -v node)" || { echo "node isn't on PATH" >&2; exit 1; }
command -v claude >/dev/null || { echo "claude isn't on PATH" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
app="$work/Agent Panel.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

swiftc -O -swift-version 5 -o "$app/Contents/MacOS/AgentPanel" "$here/main.swift"
swift "$here/render-icon.swift" "$here/icon.svg" "$work/AppIcon.iconset"
iconutil -c icns -o "$app/Contents/Resources/AppIcon.icns" "$work/AppIcon.iconset"

plist="$app/Contents/Info.plist"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n' > "$plist"
str() { plutil -insert "$1" -string "$2" "$plist"; }
str CFBundleIdentifier "$id"
str CFBundleName "Agent Panel"
str CFBundleDisplayName "Agent Panel"
str CFBundleExecutable AgentPanel
str CFBundleIconFile AppIcon
str CFBundlePackageType APPL
str CFBundleShortVersionString 1.0
str CFBundleVersion "$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo 1)"
str LSMinimumSystemVersion 14.0
str LSApplicationCategoryType public.app-category.developer-tools
plutil -insert NSHighResolutionCapable -bool YES "$plist"
plutil -insert NSAppTransportSecurity -json '{"NSAllowsLocalNetworking":true}' "$plist"
str ACPRepo "$repo"
str ACPNode "$node"
str ACPPath "$PATH"
str ACPPort "$port"
plutil -lint "$plist" >/dev/null

codesign --force --sign - "$app"

mkdir -p "$(dirname "$out")"
rm -rf "$out"
mv "$app" "$out"
echo "Built $out (port $port, node $node)"
