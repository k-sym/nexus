#!/usr/bin/env bash
# Launch the Even G2 simulator against the cockpit dev server with the automation
# HTTP API enabled, so the HUD can be screenshotted / driven from scripts (and AI
# agents). The simulator renders the real 576×288 monochrome glasses framebuffer.
#
# Prereq: the dev server must already be running (`npm run dev`, port 5273).
#
# Usage: scripts/sim.sh [fixture] [automation-port]
#   fixture           a ?sim= scenario: detail-long | detail-short | list | question
#                     (or "" / "live" to load the normal app instead of a fixture)
#   automation-port   HTTP control port (default 9898)
#
# Automation (see @evenrealities/evenhub-simulator README):
#   screenshot:  curl http://127.0.0.1:9898/api/screenshot/glasses -o hud.png
#   scroll/tap:  curl -XPOST http://127.0.0.1:9898/api/input -d '{"action":"down"}'
#                actions: up | down | click | double_click
#   console:     curl http://127.0.0.1:9898/api/console
set -euo pipefail

FIXTURE="${1:-detail-long}"
PORT="${2:-9898}"
DEV_PORT="${DEV_PORT:-5273}"

URL="http://localhost:${DEV_PORT}/"
if [ -n "$FIXTURE" ] && [ "$FIXTURE" != "live" ]; then
  URL="${URL}?sim=${FIXTURE}"
fi

if ! curl -fsS -m 1 "http://localhost:${DEV_PORT}/" >/dev/null 2>&1; then
  echo "✗ dev server not reachable on :${DEV_PORT} — run 'npm run dev' first" >&2
  exit 1
fi

echo "→ simulator loading ${URL}"
echo "  automation:  http://127.0.0.1:${PORT}   (screenshot: /api/screenshot/glasses, input: POST /api/input)"
exec npx evenhub-simulator "$URL" --automation-port "$PORT"
