#!/bin/sh
# The Agent Panel worker's launcher. launchd runs this; it runs the current version of the worker and, while a new
# version is being tried, puts the previous one back when the new one cannot start three times in a row. The installer
# writes this file once; the worker never updates it, so it is always there to fall back on.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="__NODE__"
if [ -f "$DIR/switch" ]; then
  read -r to from tries < "$DIR/switch"
  if [ "$(cat "$DIR/started" 2>/dev/null)" = "$to" ]; then
    rm -f "$DIR/switch"
  else
    tries=$((tries + 1))
    if [ "$tries" -ge 3 ]; then
      ln -sfn "$DIR/$from" "$DIR/current"
      printf '%s %s\n' "$to" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/rolled-back"
      rm -f "$DIR/switch"
    else
      printf '%s %s %s\n' "$to" "$from" "$tries" > "$DIR/switch"
    fi
  fi
fi
[ -f "$DIR/current/server.mjs" ] || { echo "worker/current is missing; run the install line again" >&2; exit 1; }
exec "$NODE" "$DIR/current/server.mjs"
