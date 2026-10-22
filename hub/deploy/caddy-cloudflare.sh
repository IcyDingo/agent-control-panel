#!/bin/sh
# Teach Caddy that Cloudflare's addresses are trusted proxies, and hand the hub the real visitor's address as the only
# X-Forwarded-For entry. Rewrites the universe.cashegg.com block and adds a global options block if there is none.
set -e
CF="$(curl -sf https://www.cloudflare.com/ips-v4) $(curl -sf https://www.cloudflare.com/ips-v6)"
[ -n "$CF" ] || { echo "could not fetch Cloudflare's ranges"; exit 1; }
RANGES="$(echo $CF | tr '\n' ' ')"
F=/etc/caddy/Caddyfile
cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"
# Drop the old universe block (from its first line to its closing brace) and any earlier global block of ours.
awk '
  /^universe\.cashegg\.com \{/ { skip=1 }
  /^# cloudflare-trusted-proxies/ { skip=1 }
  skip && /^\}/ { skip=0; next }
  !skip { print }
' "$F" > "$F.new"
{
  echo "# cloudflare-trusted-proxies (written by /srv/agent-hub/caddy-cloudflare.sh; the ranges come from cloudflare.com/ips)"
  echo "{"
  echo "    servers {"
  echo "        trusted_proxies static $RANGES"
  echo "        # The visitor's address is what Cloudflare says in its own header, never anything the visitor sent along;"
  echo "        # and only when the connection really comes from Cloudflare (strict: nothing is believed from an untrusted peer)."
  echo "        client_ip_headers CF-Connecting-IP"
  echo "        trusted_proxies_strict"
  echo "    }"
  echo "}"
  echo
  cat "$F.new"
  echo
  echo "universe.cashegg.com {"
  echo "    reverse_proxy 127.0.0.1:4848 {"
  echo "        # The visitor as Caddy worked it out: Cloudflare's CF-Connecting-IP when the call came through Cloudflare,"
  echo "        # the peer itself otherwise. The hub reads the last (here the only) entry."
  echo "        header_up X-Forwarded-For {client_ip}"
  echo "    }"
  echo "}"
} > "$F.rewritten"
rm "$F.new"
caddy validate --config "$F.rewritten" >/dev/null
mv "$F.rewritten" "$F"
systemctl reload caddy
echo "caddy reloaded with $(echo $RANGES | wc -w) Cloudflare ranges"
