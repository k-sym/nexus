#!/usr/bin/env bash
#
# Rebuild the backend and restart the launchd service that runs it.
#
# The backend runs from built output (src/backend/dist/index.js), not from
# source, so editing TypeScript changes nothing until it is rebuilt — and the
# long-lived launchd process keeps serving the old build until it is restarted.
# This does both, in that order, and then waits for the service to answer.
#
# Shared types are built first: the backend imports @nexus/shared, so a stale
# shared/dist silently compiles the backend against yesterday's types.
#
# Usage:
#   npm run restart:backend           # build + restart + health check
#   npm run restart:backend -- --skip-build   # restart only (no rebuild)
#
# Falls back to a plain foreground start when the launchd job isn't installed,
# so this still works on a machine that runs the backend by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LABEL="com.k-sym.nexus-backend"
LOG="$HOME/Library/Logs/nexus-backend.log"
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# The port the health check should poll: server.port in ~/.nexus/config.yaml,
# falling back to the backend's built-in default. Scoped to the `server:` block
# on purpose — config.yaml has several `port:` keys (the gateway's :8899, the
# daemon's :4100), and matching the first one anywhere would poll the wrong
# service the moment the file is reordered.
PORT="$(awk '
  /^[^[:space:]#]/ { in_server = ($0 ~ /^server:/) }
  in_server && $1 == "port:" { print $2; exit }
' "$HOME/.nexus/config.yaml" 2>/dev/null)"
PORT="${PORT:-4173}"

# npm rewrites node_modules/.package-lock.json on every install, so a root
# lockfile newer than it means the tree on disk no longer matches what the
# lockfile asks for — the usual cause is pulling or rebasing onto a commit that
# regenerated it. The build still succeeds (tsc does not care), and the backend
# then dies during startup with nothing useful in the log, so warn loudly.
if [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
  echo "!! package-lock.json is newer than the installed tree — run \`npm install\` first."
  echo "   (A build against a stale node_modules can fail at runtime, not at compile time.)"
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Building @nexus/shared"
  npm run --workspace=src/shared build
  echo "==> Building @nexus/backend"
  npm run --workspace=src/backend build
else
  echo "==> Skipping build (--skip-build)"
fi

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "==> Restarting $LABEL"
  # kickstart -k stops the running instance and starts a fresh one under
  # launchd, which `kill` alone would not do correctly.
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  echo "==> $LABEL is not loaded — starting the backend in the foreground instead."
  echo "    (ctrl-c to stop; install the LaunchAgent to run it as a service)"
  exec node src/backend/dist/index.js
fi

echo "==> Waiting for http://127.0.0.1:$PORT/api/health"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    echo "==> Backend healthy on :$PORT (pid $(launchctl list | awk -v l="$LABEL" '$3 == l { print $1 }'))"
    exit 0
  fi
  sleep 1
done

echo "!! Backend did not become healthy within 30s." >&2
echo "   Last 20 log lines from $LOG:" >&2
tail -20 "$LOG" >&2 2>/dev/null || echo "   (no log at $LOG)" >&2
exit 1
