#!/bin/bash
# Double-click to launch Clip Cataloger.
# This script:
#   1. cd's into the repo it lives in
#   2. installs npm deps if needed
#   3. builds the UI if dist/ is missing or stale
#   4. starts the server
#   5. opens http://localhost:5174 in your default browser

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "[clip-cataloger] working in $DIR"

if [ ! -d node_modules ]; then
  echo "[clip-cataloger] installing dependencies (one-time, ~30s)…"
  npm install
fi

NEED_BUILD=0
if [ ! -f dist/index.html ]; then
  NEED_BUILD=1
elif [ -n "$(find src server -newer dist/index.html -type f -print -quit 2>/dev/null)" ]; then
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" = "1" ]; then
  echo "[clip-cataloger] building UI…"
  npm run build
fi

PORT=$(node -e "require('dotenv').config(); console.log(process.env.PORT || 5174)" 2>/dev/null || echo 5174)
URL="http://localhost:$PORT"

(
  sleep 2
  open "$URL"
) &

echo "[clip-cataloger] launching at $URL"
echo "[clip-cataloger] press Ctrl+C in this window to stop the app"
exec npm start
