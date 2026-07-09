#!/usr/bin/env bash
# Print a ready-to-scan QR that loads the Session Cockpit HUD on your G2 glasses.
#
# Detects this Mac's LAN IP, builds the app URL with the ?hub= auto-connect param
# baked in, preflights that the dev server + hub are actually reachable on that IP,
# then renders the QR via `evenhub qr`. Scan it in the Even app's dev-load screen.
#
# Env overrides:
#   DEV_PORT   dev server port      (default 5173)
#   HUB_PORT   hub port             (default 8899)
#   HUB_TOKEN  bearer token         (default empty; appended as &token= when set)
#   TS=1       use this Mac's Tailscale IP (reach the glasses from any tailnet)
#   LAN_IP     force the IP         (overrides TS and auto-detection)
set -euo pipefail

DEV_PORT="${DEV_PORT:-5173}"
HUB_PORT="${HUB_PORT:-8899}"
HUB_TOKEN="${HUB_TOKEN:-${COCKPIT_HUB_TOKEN:-}}"

# --- find the LAN IP the phone can reach this Mac at ------------------------
detect_ip() {
  local iface ip
  iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
  [ -n "$iface" ] && ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  if [ -z "${ip:-}" ]; then
    for i in en0 en1 en2 en3 en4 en5 en6 en7 en8; do
      ip="$(ipconfig getifaddr "$i" 2>/dev/null || true)"; [ -n "$ip" ] && break
    done
  fi
  if [ -z "${ip:-}" ]; then
    ip="$(ifconfig 2>/dev/null | awk '/inet /{print $2}' \
      | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -1 || true)"
  fi
  printf '%s' "${ip:-}"
}

# --- this Mac's Tailscale IP, tolerating CLI vs app-bundle install ----------
tailscale_ip() {
  local bin
  for bin in tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale \
             /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    if command -v "$bin" >/dev/null 2>&1; then
      "$bin" ip -4 2>/dev/null | head -1 && return 0
    fi
  done
  return 1
}

if [ -n "${LAN_IP:-}" ]; then
  IP="$LAN_IP"
elif [ "${TS:-}" = "1" ] || [ "${USE_TAILSCALE:-}" = "1" ]; then
  IP="$(tailscale_ip || true)"
  [ -z "$IP" ] && { echo "✗ TS=1 but no Tailscale IP — is Tailscale up? ($0)" >&2; exit 1; }
  echo "(via Tailscale — phone must be on the same tailnet)"
else
  IP="$(detect_ip)"
fi
if [ -z "$IP" ]; then
  echo "✗ Could not determine an IP. Set LAN_IP=..., or TS=1 for Tailscale. ($0)" >&2
  exit 1
fi

URL="http://$IP:$DEV_PORT/?hub=http://$IP:$HUB_PORT"
[ -n "$HUB_TOKEN" ] && URL="$URL&token=$HUB_TOKEN"

# --- preflight: is each server actually reachable on the LAN IP? ------------
reachable() { curl -fsS -m 1 -o /dev/null "$1" 2>/dev/null; }

echo "host IP:     $IP"
if reachable "http://$IP:$DEV_PORT/"; then
  echo "dev server:  ✓ reachable on :$DEV_PORT"
else
  echo "dev server:  ✗ not reachable on $IP:$DEV_PORT"
  echo "             → start it:  npm run dev        (it must bind --host, which it does)"
fi
if health="$(curl -fsS -m 1 "http://$IP:$HUB_PORT/api/health" 2>/dev/null)"; then
  armed="$(printf '%s' "$health" | sed -n 's/.*"armed":\([a-z]*\).*/\1/p')"
  echo "hub:         ✓ reachable on :$HUB_PORT (armed=$armed)"
else
  echo "hub:         ✗ not reachable on $IP:$HUB_PORT"
  echo "             → it defaults to 127.0.0.1-only; bind the LAN:"
  echo "               HUB_HOST=0.0.0.0 npm --prefix ../hub start"
fi

echo
echo "URL:  $URL"
echo

if ! command -v evenhub >/dev/null 2>&1; then
  echo "ℹ evenhub CLI not found. Install it, then re-run:"
  echo "    npm install -g @evenrealities/evenhub-cli"
  echo "  (URL above works for manual entry in the meantime.)"
  exit 0
fi

echo "Scan this in the Even app (developer / dev-load screen):"
echo
exec evenhub qr --url "$URL"
