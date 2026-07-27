# Clipper Cowboy landing site

This folder is a self-contained static marketing site. It has no build step and no runtime dependencies.

## Preview locally

From the repository root:

```sh
python3 -m http.server 4173 --directory site
```

Then open [http://localhost:4173](http://localhost:4173).

## Live address

The site is built to be served from the default GitHub Pages address for this
repository:

```
https://princezoho.github.io/clipper-cowboy/
```

That URL is set as the canonical link and in the Open Graph and Twitter tags in
`index.html`. All asset paths are relative, so the site also works from a root
domain or any other subdirectory without edits.

## Deploy

`.github/workflows/deploy-landing.yml` publishes this folder. Pages is enabled
with **Settings > Pages > Source = GitHub Actions**, and the workflow runs on
every push to `main` that touches `site/**`. The path filter keeps unrelated app
and server commits from queueing a deployment of identical bytes.

**Run workflow** on the **Actions** tab still works, for republishing without a
`site/` change.

The contents of `site/` can also be dropped on any other static host, including
Cloudflare Pages, Netlify, or existing Jeje Studios hosting.

## Moving to clippercowboy.jejestudios.com later

The site does not ship a `CNAME` file, because committing one while DNS still
points elsewhere would break the working default Pages URL.

`clippercowboy.jejestudios.com` currently answers with `A` records in the
`216.150.x.x` range (Vercel), not GitHub Pages, so it has to be repointed first.
Verify what is live before changing anything:

```sh
dig +short clippercowboy.jejestudios.com A CNAME
```

Because this is a subdomain, a single `CNAME` record is all that is needed:

| Type  | Name              | Value                    | TTL  |
| ----- | ----------------- | ------------------------ | ---- |
| CNAME | `clippercowboy`   | `princezoho.github.io.`  | 3600 |

Set that on the `jejestudios.com` zone, and remove any existing `A`, `AAAA`, or
`CNAME` record on the `clippercowboy` name first, since a `CNAME` cannot coexist
with other records at the same name.

Apex domains cannot use `CNAME`. Only if you ever serve the bare
`jejestudios.com` from Pages would you instead need these four `A` records plus
four `AAAA` records:

| Type | Name | Value            |
| ---- | ---- | ---------------- |
| A    | `@`  | `185.199.108.153` |
| A    | `@`  | `185.199.109.153` |
| A    | `@`  | `185.199.110.153` |
| A    | `@`  | `185.199.111.153` |

| Type | Name | Value                  |
| ---- | ---- | ---------------------- |
| AAAA | `@`  | `2606:50c0:8000::153`  |
| AAAA | `@`  | `2606:50c0:8001::153`  |
| AAAA | `@`  | `2606:50c0:8002::153`  |
| AAAA | `@`  | `2606:50c0:8003::153`  |

Once DNS resolves, enter the domain in **Settings > Pages > Custom domain**.
GitHub commits the `CNAME` file itself at that point. Wait for the TLS
certificate to be issued, then enable **Enforce HTTPS**, and update the
canonical link and the `og:`/`twitter:` URLs in `index.html` to the new domain.

Verify the record with:

```sh
dig +short clippercowboy.jejestudios.com CNAME
```

## Assets

Product screenshots live in `site/media/`. All three are captured against the
fully synthetic "Meridian Line S02" sample project, so nothing on this page
shows real footage, real filenames, or a real filesystem path.

| File            | Section              | Dimensions | PNG     | WebP    |
| --------------- | -------------------- | ---------- | ------- | ------- |
| `hero-pool`     | hero and chapter 01  | 3200x2000  | 1175 KB | 274 KB  |
| `hero-editor`   | chapter 02           | 3200x2160  | 674 KB  | 176 KB  |
| `hero-library`  | chapter 03           | 3200x2000  | 884 KB  | 262 KB  |

Each one ships as both `.webp` and `.png` and is wired up with `<picture>`:

```html
<picture>
  <source srcset="./media/hero-pool.webp" type="image/webp" />
  <img src="./media/hero-pool.png" width="3200" height="2000" ... />
</picture>
```

Every browser in the support matrix takes the WebP, so the PNGs cost no
bandwidth. They are kept because a text-only page would be a poor failure mode
if a client ever did skip the WebP, and because `og-card` is cropped from
`hero-pool.png`.

## Social card

`og:image` and `twitter:image` point at a purpose-built card, not at a product
screenshot. A screenshot fails as a card: the networks crop to 1.91:1, and 20
clip tiles are unreadable at the roughly 400px a feed actually renders.

| File            | Purpose                       | Dimensions | Size   |
| --------------- | ----------------------------- | ---------- | ------ |
| `og-card.html`  | source, screenshotted at 1:1  | 1200x630   | 6 KB   |
| `og-card.png`   | lossless export               | 1200x630   | 338 KB |
| `og-card.jpg`   | what crawlers fetch           | 1200x630   | 129 KB |

The JPEG is wired up because it is a third of the PNG with no visible
difference, and every crawler accepts JPEG. The PNG is kept as the master for
any future crop or resize.

`og-card.html` is standalone: it repeats the brand faces, the hero gradient, and
the palette as literal values so a later change to `styles.css` cannot silently
alter a card that is already circulating. Edit that file, then regenerate both
exports from the repository root:

```sh
python3 -m http.server 4173 --directory site &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=4000 \
  --screenshot=site/media/og-card.png \
  http://localhost:4173/media/og-card.html
ffmpeg -y -i site/media/og-card.png -compression_level 100 -pred mixed /tmp/og.png
mv /tmp/og.png site/media/og-card.png
ffmpeg -y -i site/media/og-card.png -q:v 2 -pix_fmt yuvj444p site/media/og-card.jpg
```

The page is served over HTTP rather than opened as a `file://` URL so the brand
fonts load. `--force-device-scale-factor=1` is what guarantees exactly 1200x630
on a Retina display. The second `ffmpeg` pass keeps 4:4:4 chroma, so the cream
type on the dark ground stays crisp. No `@font-face` rule, font file, or
existing screenshot is touched by this process.

After deploying, re-fetch the card on the networks that cache it, at
[cards-dev.twitter.com/validator](https://cards-dev.twitter.com/validator) and
[developers.facebook.com/tools/debug](https://developers.facebook.com/tools/debug/).

The hero image loads eagerly and is preloaded. The three below the fold use
`loading="lazy"`. Every `img` carries `width` and `height` so the layout does
not shift, which is why `img { height: auto }` is in `styles.css`.

`logo.png` is the brand mark in the header.

The same screenshots are also kept in `docs/screenshots/` for the repository
README.

## Typography

The brand faces are self-hosted from `site/media/fonts/` and are committed to
the repository under licenses the project owner has confirmed cover this use:

| Face                     | Role                        | woff2  | Original `.otf` |
| ------------------------ | --------------------------- | ------ | --------------- |
| Wantedo                  | display headings            | 106 KB | 337 KB          |
| Adobe Garamond Pro Bold  | body copy                   | 41 KB  | 75 KB           |

Each `@font-face` lists the `woff2` first and the original `.otf` as a fallback,
with `font-display: swap`. Neither face is subsetted, so the full glyph set
ships and accented characters and punctuation are preserved.

Regenerate the `woff2` files after replacing a source font:

```sh
python3 -m venv /tmp/fontenv
/tmp/fontenv/bin/pip install fonttools brotli
/tmp/fontenv/bin/python - <<'PY'
from fontTools.ttLib import TTFont
for src, out in (("Wantedo.otf", "Wantedo.woff2"), ("Garamond.otf", "Garamond.woff2")):
    font = TTFont(f"site/media/fonts/{src}")
    font.flavor = "woff2"
    font.save(f"site/media/fonts/{out}")
PY
```

Interface labels, buttons, and code samples intentionally use a system
sans-serif stack. The arrow and bullet characters used in those labels are not
present in either brand face, so keeping them in the sans stack avoids a
per-character fallback.
