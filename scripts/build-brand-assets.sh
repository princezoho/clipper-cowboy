#!/bin/bash
# Brand assets: public/logo.png is the canonical UI mask (never overwritten).
# public/app-icon.png is letterboxed from logo.svg / CLIPPER_LOGO_SVG / logo.png.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "${REPO}/scripts/build-app-icon.sh"
