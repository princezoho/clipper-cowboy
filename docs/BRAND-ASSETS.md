# Brand assets

## Canonical files

| Asset | Path | Role |
|-------|------|------|
| UI mask (in-app logo) | `public/logo.png` | CSS `mask-image` / `-webkit-mask` — **do not overwrite** |
| Dock / `.app` icon (optional) | `public/app-icon.png` | Built **only** from your vector file when present |
| Vector source (not in repo yet) | `public/logo.svg` | Preferred input for `npm run build:app-icon` |

There is **no** `logo.svg` in this repository today. Git history has never contained an SVG logo file.

## Building the Dock icon

```bash
# Place your real SVG at public/logo.svg (or set CLIPPER_LOGO_SVG=/path/to/file.svg)
npm run build:app-icon
npm run package:desktop
```

`scripts/build-app-icon.sh` rasterizes your existing SVG with `rsvg-convert` or `qlmanage` + `sips`. It does **not** redraw paths, dilate outlines, or fill holes in Python.

If no vector file is present, `app-icon.png` is not generated and packaging uses `public/logo.png` as-is.

## Finder icon cache

After reinstalling `Clipper Cowboy.app` on the Desktop:

```bash
touch ~/Desktop/Clipper\ Cowboy.app
killall Finder    # or log out/in
```

If the Dock icon still looks stale: `sudo touch /Applications` (forces icon cache refresh on some macOS versions).

## Please add your SVG

Copy your original logo SVG into `public/logo.svg` (or tell us the path via `CLIPPER_LOGO_SVG`) so Dock icons match your artwork without raster hacks on `logo.png`.
