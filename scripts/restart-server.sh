#!/usr/bin/env bash
# Kill stale clip-server, re-bundle from latest TS sources, and relaunch.
# Falls back to running tsx directly if esbuild is not available locally.
set -u

cd "$(dirname "$0")/.."
PORT="${PORT:-47474}"

echo "[restart] freeing port $PORT..."
PID=$(lsof -ti:"$PORT" 2>/dev/null || true)
if [ -n "$PID" ]; then
  kill -9 $PID 2>/dev/null || sudo -n kill -9 $PID || {
    echo "[restart] could not kill $PID — try: sudo kill -9 $PID" >&2
    exit 1
  }
  sleep 1
fi
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "[restart] port $PORT still bound" >&2
  exit 1
fi

if command -v esbuild >/dev/null 2>&1; then
  echo "[restart] bundling .clip-server.mjs with esbuild..."
  esbuild server/index.ts \
    --bundle --platform=node --format=esm --packages=external \
    --outfile=.clip-server.mjs >/dev/null
  LAUNCH=(node .clip-server.mjs)
elif [ -x node_modules/.bin/esbuild ]; then
  echo "[restart] bundling .clip-server.mjs with local esbuild..."
  node_modules/.bin/esbuild server/index.ts \
    --bundle --platform=node --format=esm --packages=external \
    --outfile=.clip-server.mjs >/dev/null
  LAUNCH=(node .clip-server.mjs)
else
  echo "[restart] no esbuild — launching tsx directly (auto-reloads on TS changes)"
  LAUNCH=(npx --no-install tsx server/index.ts)
fi

echo "[restart] launching: ${LAUNCH[*]}"
nohup "${LAUNCH[@]}" >/tmp/clip-server.log 2>&1 &
sleep 2

echo "[restart] /api/health:"
curl -s "http://localhost:$PORT/api/health" | python3 -m json.tool 2>/dev/null || cat /tmp/clip-server.log | tail -20

echo
echo "[restart] /api/pool/clips-summary (first source):"
curl -s "http://localhost:$PORT/api/pool/clips-summary" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); ks=list(d.keys()); print(len(ks),'sources have clips'); print(ks[0],'→',d[ks[0]]) if ks else print('(no clips yet)')" 2>/dev/null || true
