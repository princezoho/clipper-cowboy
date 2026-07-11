#!/usr/bin/env python3
"""Letterbox a raster logo onto a square canary-yellow canvas (no path redraw)."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

SIZE = 1024
FIT_FRAC = 0.86  # max logo extent as fraction of canvas (equal padding)
BG = (255, 225, 53)  # #FFE135


def letterbox(src: Path, dest: Path) -> None:
    logo = Image.open(src).convert("RGBA")
    lw, lh = logo.size
    if lw < 1 or lh < 1:
        raise SystemExit(f"Invalid image size: {src}")

    target = int(SIZE * FIT_FRAC)
    scale = min(target / lw, target / lh)
    nw = max(1, round(lw * scale))
    nh = max(1, round(lh * scale))
    logo = logo.resize((nw, nh), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (SIZE, SIZE), (*BG, 255))
    ox = (SIZE - nw) // 2
    oy = (SIZE - nh) // 2
    canvas.paste(logo, (ox, oy), logo)
    canvas.convert("RGB").save(dest, "PNG", optimize=True)


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: build-app-icon.py <raster-logo> <out.png>", file=sys.stderr)
        sys.exit(2)
    src = Path(sys.argv[1])
    dest = Path(sys.argv[2])
    if not src.is_file():
        print(f"Missing {src}", file=sys.stderr)
        sys.exit(1)
    letterbox(src, dest)
    print(f"App icon built: {dest} ({SIZE}×{SIZE}, letterboxed from {src.name})")


if __name__ == "__main__":
    main()
