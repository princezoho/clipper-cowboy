#!/bin/bash
# Stop Clipper Cowboy only when /api/health responds (avoids killing unrelated apps).

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

BASE_PORT=$(node -e "require('dotenv').config(); console.log(process.env.PORT || 47474)" 2>/dev/null || echo 47474)
MAX_PORT=$((BASE_PORT + 50))

health_ok() {
  local p="$1"
  curl -sf --max-time 2 "http://localhost:${p}/api/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
}

stopped=0
for ((p = BASE_PORT; p <= MAX_PORT; p++)); do
  if ! health_ok "$p"; then
    continue
  fi
  pids=$(lsof -tiTCP:"${p}" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$pids" ]; then
    continue
  fi
  echo "[clipper-cowboy] stopping server on port ${p} (PID(s): ${pids//$'\n'/ })"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  if lsof -tiTCP:"${p}" -sTCP:LISTEN >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  stopped=1
done

if [ "$stopped" = "0" ]; then
  echo "[clipper-cowboy] no Clipper Cowboy server found on ports ${BASE_PORT}–${MAX_PORT}"
fi
