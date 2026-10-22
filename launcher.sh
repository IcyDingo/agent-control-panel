#!/bin/sh
# The Agent Panel worker's launcher. launchd runs this; it runs the current version of the worker and, while a new
# version is being tried, puts the previous one back when the new one cannot start three times in a row. The installer
# writes this file once; the worker never updates it, so it is always there to fall back on.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="__NODE__"
# The `switch` format (`<to> <from> <tries>`) is frozen, because this launcher is never updated: every later worker
# must write what this one reads. A switch it cannot read (a field missing, a version not there, a count that is not
# a number) is dropped and current runs, so a damaged file cannot stop the worker for good.
if [ -f "$DIR/switch" ]; then
  to= from= tries=
  read -r to from tries < "$DIR/switch"
  tries="${tries:-0}"
  valid=1
  for x in "$to" "$from"; do [ -n "$x" ] && [ -f "$DIR/$x/server.mjs" ] || valid=0; done
  case "$tries" in *[!0-9]*) valid=0 ;; esac
  if [ "$valid" = 0 ] || [ "$(cat "$DIR/started" 2>/dev/null)" = "$to" ]; then
    rm -f "$DIR/switch"
  else
    # expr, not $(( )): a count like 08 would be read as octal there, and fail.
    tries=$(expr "$tries" + 1)
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
