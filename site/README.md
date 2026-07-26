# Clipper Cowboy landing site

This folder is a self-contained static marketing site. It has no build step and no runtime dependencies.

## Preview locally

From the repository root:

```sh
python3 -m http.server 4173 --directory site
```

Then open [http://localhost:4173](http://localhost:4173).

## Deploy

Deploy the contents of `site/` to any static host, including GitHub Pages, Cloudflare Pages, Netlify, or existing Jeje Studios hosting. The site uses relative asset paths, so it can be served from a root domain or a subdirectory.

To use `clippercowboy.jejestudios.com`, the domain owner must create the required DNS CNAME record with their hosting provider. This repository does not change DNS, GitHub Pages settings, or domain configuration.

## Optional GitHub Pages workflow

`.github/workflows/deploy-landing.yml` is manual-only and deploys this `site/` folder when GitHub Pages has been enabled in the repository settings. To use it:

1. In GitHub repository Settings, set Pages source to GitHub Actions.
2. Open the Actions tab and run **Deploy landing site** with **Run workflow**.
3. Configure the custom domain in GitHub Pages settings after the DNS CNAME is in place.

The workflow intentionally does not add a `CNAME` file or configure a domain.

## Assets

The site copies these real, sanitized product assets into `site/media/`:

- `landing-pool.png`
- `pool.png` for social previews
- `editor-clip-range.png`
- `logo.png`

Typography uses system font fallbacks. No third-party font binaries are
redistributed with the repository.
