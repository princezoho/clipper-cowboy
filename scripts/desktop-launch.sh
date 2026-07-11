#!/bin/bash
# Launched by Clipper Cowboy.app — installs deps, builds if needed, starts server, opens browser.

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "[clipper-cowboy] working in $DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install from https://nodejs.org/ then try again."
  read -r -p "Press Enter to close…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[clipper-cowboy] installing dependencies (one-time)…"
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

BASE_PORT=$(node -e "require('dotenv').config(); console.log(process.env.PORT || 47474)" 2>/dev/null || echo 47474)
MAX_PORT=$((BASE_PORT + 50))

health_ok() {
  local p="$1"
  curl -sf --max-time 2 "http://localhost:${p}/api/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
}

port_in_use() {
  local p="$1"
  lsof -nP -iTCP:"${p}" -sTCP:LISTEN >/dev/null 2>&1
}

# Already running somewhere in our port range?
for ((p = BASE_PORT; p <= MAX_PORT; p++)); do
  if health_ok "$p"; then
    URL="http://localhost:${p}"
    echo "[clipper-cowboy] already running at ${URL}"
    open "$URL"
    echo "[clipper-cowboy] opened in your browser. Stop it with Ctrl+C in that Terminal window, or: npm run stop"
    exit 0
  fi
done

# Pick first free port (never kill another app on a busy port).
CHOSEN_PORT=""
for ((p = BASE_PORT; p <= MAX_PORT; p++)); do
  if ! port_in_use "$p"; then
    CHOSEN_PORT="$p"
    break
  fi
done

if [ -z "$CHOSEN_PORT" ]; then
  echo "[clipper-cowboy] no free port between ${BASE_PORT} and ${MAX_PORT}."
  read -r -p "Press Enter to close…"
  exit 1
fi

if [ "$CHOSEN_PORT" != "$BASE_PORT" ]; then
  echo "[clipper-cowboy] port ${BASE_PORT} is in use by another app — using ${CHOSEN_PORT} instead"
fi

export PORT="$CHOSEN_PORT"
URL="http://localhost:${PORT}"

(
  sleep 2
  open "$URL"
) &

echo "[clipper-cowboy] running at ${URL}"
echo "[clipper-cowboy] press Ctrl+C in this window to stop"
exec npm start
