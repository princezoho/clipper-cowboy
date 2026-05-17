#!/bin/bash
# Double-click to launch Clipper Cowboy.
# This script:
#   1. cd's into the repo it lives in
#   2. installs npm deps if needed
#   3. builds the UI if dist/ is missing or stale
#   4. starts the server
#   5. opens http://localhost:$PORT in your default browser
#
# Note: filename kept as "Clip Cataloger.command" for backwards compatibility
# with existing Finder bookmarks. Rename it to "Clipper Cowboy.command" if
# you like — nothing else references it by name.

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "[clipper-cowboy] working in $DIR"

if [ ! -d node_modules ]; then
  echo "[clipper-cowboy] installing dependencies (one-time, ~30s)…"
  npm install
fi

NEED_BUILD=0
if [ ! -f dist/index.html ]; then
  NEED_BUILD=1
elif [ -n "$(find src server -newer dist/index.html -type f -print -quit 2>/dev/null)" ]; then
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" = "1" ]; then
  echo "[clipper-cowboy] building UI…"
  npm run build
fi

PORT=$(node -e "require('dotenv').config(); console.log(process.env.PORT || 47474)" 2>/dev/null || echo 47474)
URL="http://localhost:$PORT"

(
  sleep 2
  open "$URL"
) &

echo "[clipper-cowboy] launching at $URL"
echo "[clipper-cowboy] press Ctrl+C in this window to stop the app"
exec npm start
