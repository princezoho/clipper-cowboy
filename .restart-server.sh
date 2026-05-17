#!/usr/bin/env bash
# Rebuild + restart the clipper-cowboy backend on :47474.
# (Auto-generated helper — safe to delete.)
set -e
cd "$(dirname "$0")"

./node_modules/.bin/esbuild server/index.ts \
  --bundle --platform=node --target=node22 --format=esm \
  --packages=external --outfile=.clip-server.mjs

PID=$(lsof -ti:47474 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "killing existing server pid $PID"
  kill "$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null || true
  sleep 1
fi

nohup node .clip-server.mjs > /tmp/clip-server.log 2>&1 &
disown
sleep 2
tail -20 /tmp/clip-server.log
echo "---"
echo "listening on $(lsof -ti:47474)"
