#!/bin/bash
# Build public/app-icon.png: letterboxed logo on #FFE135 (never overwrites logo.png).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGO_PNG="${REPO}/public/logo.png"
LOGO_SVG="${REPO}/public/logo.svg"
OUT="${REPO}/public/app-icon.png"
PY="${REPO}/scripts/build-app-icon.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SIZE=1024
RASTER_MAX=2048

resolve_source() {
  if [ -n "${CLIPPER_LOGO_SVG:-}" ] && [ -f "${CLIPPER_LOGO_SVG}" ]; then
    printf '%s\n' "${CLIPPER_LOGO_SVG}"
    return
  fi
  if [ -f "$LOGO_SVG" ]; then
    printf '%s\n' "$LOGO_SVG"
    return
  fi
  if [ -f "$LOGO_PNG" ]; then
    printf '%s\n' "$LOGO_PNG"
    return
  fi
  echo "Missing logo source: set CLIPPER_LOGO_SVG, add public/logo.svg, or public/logo.png" >&2
  exit 1
}

rasterize_svg() {
  local svg="$1"
  local out="$2"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert --keep-aspect-ratio -w "$RASTER_MAX" "$svg" -o "$out"
    return
  fi
  if ! command -v qlmanage >/dev/null 2>&1; then
    echo "Need rsvg-convert or qlmanage to rasterize SVG: $svg" >&2
    exit 1
  fi
  qlmanage -t -s "$RASTER_MAX" -o "$WORK" "$svg" >/dev/null 2>&1
  local gen="${WORK}/$(basename "$svg").png"
  if [ ! -f "$gen" ]; then
    echo "qlmanage failed to rasterize: $svg" >&2
    exit 1
  fi
  cp "$gen" "$out"
}

SRC="$(resolve_source)"
RASTER="${WORK}/logo-raster.png"

case "$SRC" in
  *.[sS][vV][gG])
    rasterize_svg "$SRC" "$RASTER"
    ;;
  *.png|*.PNG)
    cp "$SRC" "$RASTER"
    ;;
  *)
    echo "Unsupported logo source (use .svg or .png): $SRC" >&2
    exit 1
    ;;
esac

python3 "$PY" "$RASTER" "$OUT"
