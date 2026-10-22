#!/bin/sh
# Only Cloudflare reaches the web ports. Writes and applies one nftables table of its own (Docker's tables are left
# alone): 80 and 443 accept connections from Cloudflare's ranges and loopback and drop the rest; the containers' host
# ports (3000, 3001, and anything Docker publishes) are unreachable from outside, both as host ports and as forwarded
# ones; SSH and everything else are not touched. The ranges come from cloudflare.com/ips; when they cannot be fetched
# the last written file is applied again. Run it after `caddy-cloudflare.sh`, and from the systemd unit at boot.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FILE="$HERE/cloudflare-only.nft"
IFACE="$(ip route show default | awk '{print $5; exit}')"
[ -n "$IFACE" ] || { echo "no default interface"; exit 1; }

V4="$(curl -sf --max-time 15 https://www.cloudflare.com/ips-v4 || true)"
V6="$(curl -sf --max-time 15 https://www.cloudflare.com/ips-v6 || true)"
if [ -n "$V4" ] && [ -n "$V6" ]; then
  cat > "$FILE.new" <<EOF
# written by firewall-cloudflare.sh on $(date -u +%FT%TZ); the ranges are cloudflare.com/ips
table inet cloudflare_only {
  set cf4 { type ipv4_addr; flags interval; elements = { $(echo $V4 | sed 's/ /, /g') } }
  set cf6 { type ipv6_addr; flags interval; elements = { $(echo $V6 | sed 's/ /, /g') } }
  chain input {
    type filter hook input priority -5; policy accept;
    iifname "lo" accept
    tcp dport { 80, 443 } ip saddr @cf4 accept
    tcp dport { 80, 443 } ip6 saddr @cf6 accept
    tcp dport { 80, 443 } drop
    tcp dport { 3000, 3001 } drop
  }
  chain forward {
    type filter hook forward priority -5; policy accept;
    iifname "$IFACE" ct state new drop
  }
}
EOF
  mv "$FILE.new" "$FILE"
elif [ -f "$FILE" ]; then
  echo "could not fetch Cloudflare's ranges; applying the last written file"
else
  echo "could not fetch Cloudflare's ranges and there is no earlier file"; exit 1
fi

nft -c -f "$FILE"
nft list table inet cloudflare_only >/dev/null 2>&1 && nft delete table inet cloudflare_only
nft -f "$FILE"
echo "applied: web ports open to $(echo $V4 $V6 | wc -w | tr -d ' ') Cloudflare ranges and loopback, containers closed from $IFACE"
