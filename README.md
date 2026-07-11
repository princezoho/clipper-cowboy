<p align="center">
  <img src="./public/logo.png" alt="Clipper Cowboy — cowboy hat over a film clip" width="120" />
</p>

<p align="center">
  <img src="./docs/screenshots/landing-pool.png" alt="Clipper Cowboy pool overview" width="90%"/>
</p>

# Clipper Cowboy

> Local-first triage and cataloging for AI-generated video clips.
> Drop in a folder of long montages, mark precise in/out points with optional AI
> assistance, export at near-original quality, and build a searchable library —
> all on your machine.

<p align="center">
  <a href="#quick-start">Quick start</a> |
  <a href="#architecture">Architecture</a> |
  <a href="./docs/INTEGRATIONS.md">Integrations</a> |
  <a href="#public-share-checklist-before-external-distribution">Share-readiness</a> |
  <a href="./SECURITY.md">Security</a>
</p>

---

## Why this exists

AI-video generation tooling often outputs long compositional montages where the
useful clips are buried in minutes of noise. You want the keepers, not the full
re-encode tax.

Clipper Cowboy fills that gap with a local-first, single-purpose triage workflow:

- Fast visual review + trimming
- Precise in/out capture for export
- Strong safety defaults (AI optional)
- A persistent catalog that survives restarts

It is intentionally narrow in scope: **make clip review, metadata, and export feel
frictionless**, without turning into a full NLE.

## Core landing showcase

<div align="center">

| Overview | Clip Editor | Settings |
|---|---|---|
| ![Pool and review list](./docs/screenshots/landing-pool.png) | ![Editor in/out and metadata controls](./docs/screenshots/editor-clip-range.png) | ![Settings + key handling](./docs/screenshots/settings-security.png) |

</div>




---

## Features


- **Frame-accurate clipping** with smart-cut export — zero re-encode on the
  body of every clip, lossless re-encode of at most a fraction of a second on
  the trim edges.
- **Optional GPT-4o auto-fill** for clip names, one-line descriptions, and
  tags. Skip it and the app still works.
- **First-class Characters / Scenes / Objects taxonomy** with filtering. Tag a
  character once with a few reference frames; GPT-4o will recognize them on
  every future clip.
- **"Already-clipped" overlay** on the source timeline — never re-cut the same
  shot by accident, and see at a glance how much of a source you've covered.
- **Drafts auto-save** every field change. Walk away mid-cut, come back
  tomorrow, pick up exactly where you stopped. Explicit re-export when you're
  ready to re-render.
- **Export collections** — filter the library to a tag set and get a folder
  (or zip) of hardlinked clips ready for the next NLE.
- **Activity log, integrity checks, per-source progress** so the catalog
  never silently rots.
- **Portable project folder** — one folder is one project. Source montages at
  the root, `clips/`, `characters/`, plus `shotlist.md` + `shotlist.csv`
  regenerated on every change. Open it on another machine and you have the
  whole project.

## Architecture

### High-level flow

1. **Import / indexing**
   - User selects a `PROJECT_DIR`.
   - Server scans video files and builds source metadata in sidecar state.
2. **Review loop**
   - React UI polls `/api/pool`, `/api/entities`, `/api/activity`.
   - Users annotate shots with characters / scenes / objects and adjust in/out.
3. **AI pass (optional)**
   - `server/routes/poolAnalyze.ts` calls OpenAI only when `OPENAI_API_KEY` is set.
4. **Export pipeline**
   - Server chooses keyframe-aware export path to preserve source quality and writes
     to `clips/`.
5. **Catalog persistence**
   - Shot metadata, clips, entities, and activity are saved to `.clipcataloger/`
     in the project folder.

### Tech boundaries

- **Frontend (`src/`)**: Vite + React 18 + Tailwind UI for pool/library/editor flows.
- **Backend (`server/`)**: Express API for scanning, metadata CRUD, and ffmpeg
  export orchestration.
- **AI boundary**: only optional OpenAI calls behind key presence; no AI calls are
  made by default without a key.
- **Filesystem contract**: project folder is stateful storage (all important data
  is project-local).

## Requirements

- Node 20+ (Node 22 recommended)
- `ffmpeg` and `ffprobe` are bundled via [`ffmpeg-static`][ffmpeg-static] and
  [`ffprobe-static`][ffprobe-static] — no system install required.
- macOS, Linux, or Windows. A few convenience features (`Reveal in Finder`, APFS
  clonefile-based bundle exports) are macOS-only; everything else works across
  platforms.

## Quick start

```bash
git clone https://github.com/princezoho/clipper-cowboy.git
cd clipper-cowboy
npm install
npm run dev
```

Then open <http://localhost:5173>. The first-run wizard will walk you through
pointing it at a folder of source videos and (optionally) dropping in an
OpenAI API key.

For day-to-day single-process use (no Vite, just one server):

```bash
npm run build   # builds the React bundle into dist/
npm start       # serves API + UI on :47474 from dist/
# open http://localhost:47474
```

### One-click on macOS

`Clip Cataloger.command` lives in the repo root. Double-click it in Finder —
it runs `npm install` if needed, builds the UI if `dist/` is stale, starts
the server, and opens your browser. Press `Ctrl+C` in the Terminal window to
stop the app.

If macOS warns "cannot be opened because it is from an unidentified
developer," right-click the file → Open → Open. You only need to do this
once.

## Configuration

Security-first defaults:

- **No API keys are committed in this repo.**
- `OPENAI_API_KEY` is optional — without it, AI features are disabled, but all core clip/edit/export flows keep working.
- For local use, set keys in UI **Settings** and save; the app writes them into a local `.env` file.
- The API binds to `127.0.0.1`. Do not expose it through a tunnel or reverse
  proxy; it is intentionally designed for one local user.

All settings live in a local `.env` file. The first-run wizard writes this
for you, so you typically never need to touch it.

| Var | Required | Description |
| --- | --- | --- |
| `PROJECT_DIR` | no | Project folder. Defaults to `~/ClipCataloger`. |
| `OPENAI_API_KEY` | no | GPT-4o calls (caption, character recognition). If missing, AI features stay disabled until you add a key in Settings. |
| `PORT` | no | Production server port. Defaults to `47474`. |
| `CLIPPER_STEM_STUDIO_ROOT` | no | Trusted local Stem Studio clone used for automatic background stems. You can set this in Settings. |
| `CLIPPER_STEM_STUDIO_PYTHON` | no | Optional Stem Studio Python override. |
| `CLIPPER_STEM_STUDIO_CACHE` | no | Optional Stem Studio model-cache override. |
| `CLIPPER_STEMS_TIMEOUT_MINUTES` | no | Per-job safety timeout. Defaults to 360 minutes. |

See [`.env.example`](.env.example) for a documented template.

## Background audio stems on export

Clipper Cowboy can drive Stem Studio directly while you keep editing:

1. Clone and build [wassermanproductions/stem-studio](https://github.com/wassermanproductions/stem-studio).
2. In **Settings**, enter that trusted clone's folder and restart Clipper Cowboy.
3. On a **Clip** or **Clip + Source** export, check **Create audio stems** and
   choose Fast, High, or Max.

The clip export returns immediately. A one-at-a-time local queue separates
Dialogue, Music, SFX, a married mix, and a multitrack video beneath
`PROJECT_DIR/derived/stems/`; the header's **Stems** control shows progress even
after you close the editor. Stem failures never invalidate the exported clip.

No hosted key is required for separation, and Clipper does not pass its OpenAI
key or local API token to Stem Studio. Model weights may download on first use.
Max invokes Stem Studio's additional MVSEP model; review that model's upstream
licensing before using Max in distributed or commercial work. Full setup,
lifecycle, and agent details are in [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

## Drive it from an AI agent

Clipper Cowboy includes a standalone local MCP server. From a fresh clone:

```bash
npm run setup
```

Then register `mcp/dist/index.js` in Codex or another MCP client. The agent can
check setup, list and inspect source videos, search the library, smart-cut clips,
update metadata, run confirmed OpenAI analysis, and hand completed clip paths to
Stem Studio—without opening the browser UI. See [`mcp/README.md`](mcp/README.md)
for the configuration and complete tool reference.

MCP never accepts an API key or arbitrary input/output path. It operates on
catalog IDs, keeps exports inside `clips/`, and reports only whether optional AI
is configured.

Agents can also connect both official MCP servers and use the manual handoff in
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md). The repositories share media
paths and outputs—not credentials.

## Public-share checklist before external distribution

Before sharing this repo with someone:

1. Run `npm run public:ready`.
2. Verify `.env` is ignored and not tracked.
3. Confirm this checklist and `SECURITY.md` are up to date.
4. Ensure `CODEOWNERS` is in place for merge-review ownership.
5. Confirm AI features are optional and safe-by-default when no key is set.
6. Confirm `npm run build` succeeds.

Keep your API keys local (do not commit them); this must remain private until
you're ready to publish.

## Hotkeys

### Editor

| Key            | Action                                   |
| -------------- | ---------------------------------------- |
| `Space`        | Play / pause                             |
| `J` / `K` / `L`| Reverse / pause / forward (1×)           |
| `I` / `O`      | Set in / out at current playhead         |
| `←` / `→`      | Step one frame (hold `Shift` for 10)     |
| `Enter`        | Export the current selection             |
| `Esc`          | Close the editor                         |

Inside a text input, `Enter` only triggers export when held with `⌘` /
`Ctrl`, so you can type tags freely.

## How exports work

Clipper Cowboy's exporter probes each source for keyframe positions, then:

1. **Both endpoints already land on keyframes** → single
   `ffmpeg -ss in -to out -c copy`. The output is bit-identical to the
   source bytes in that range.
2. **Otherwise** → up to three segments are concatenated: a head re-encoded
   `[in .. nextKeyframe]`, the middle stream-copied `[..]`, and a tail
   re-encoded `[prevKeyframe .. out]`. The re-encode uses lossless settings
   matched to the source codec (`libx264 -qp 0` for H.264, `libx265
   lossless=1` for HEVC, `prores_ks` for ProRes). Audio is re-encoded only on
   the edge segments.

So the **body** of every clip is bit-identical to the source, the **edges**
are at most a fraction of a second of lossless re-encode, and the **cuts are
exact** to the in/out you set.

For "Source" and "Clip + Source" bundle modes, the source is copied with
`cp -c` (APFS `clonefile(2)`) on macOS — instant, zero data written,
copy-on-write. Falls back to a regular byte copy on non-APFS volumes.

## Project structure

```
clipper-cowboy/
├── server/             # Express + ffmpeg backend (tsx watch in dev)
│   ├── routes/         # /api endpoints
│   ├── smartcut.ts     # keyframe-aware lossless export
│   └── config.ts       # env + on-disk paths
├── mcp/                # Standalone stdio MCP server for agents
├── src/                # Vite + React + Tailwind frontend
│   ├── views/          # Pool, Library, Editor, Onboarding, Settings…
│   ├── components/     # Video player, timeline, meta form…
│   └── lib/            # API client, save-state store, hooks
├── public/             # static assets (logo.png UI mask; optional logo.svg for Dock)
├── docs/BRAND-ASSETS.md # logo paths, icon build, Finder cache — read before changing brand files
└── .clip-server.mjs    # esbuild bundle of the server (gitignored)
```

A project folder on disk looks like this:

```
PROJECT_DIR/
├── *.mp4                       # source montages at root (the "pool")
├── clips/                      # exported clips (the "library")
│   Cartoon_Band_Performing.mp4
├── characters/                 # character library
│   Buck/character.json + refs/
├── derived/stems/              # external Stem Studio outputs (not re-imported)
├── shotlist.md                 # human-readable index
├── shotlist.csv                # machine-readable index
└── .clipcataloger/             # caches + sidecars (safe to delete)
```

> **Note on the `.clipcataloger/` folder name**: it's kept that way on
> purpose. Renaming would orphan existing users' drafts, captions, and
> activity logs. The branded app name is "Clipper Cowboy"; the sidecar
> folder name is just a stable identifier from the project's earlier life
> as "clip-cataloger".

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to get a dev
loop running and what we're looking for.

## License

[MIT](LICENSE).

## Credits

Built with:

- [`ffmpeg-static`][ffmpeg-static] + [`ffprobe-static`][ffprobe-static] —
  bundled ffmpeg binaries so users don't need a system install.
- [`openai`](https://github.com/openai/openai-node) — GPT-4o vision for clip
  captioning + character recognition.
- [Vite](https://vitejs.dev/) + [React](https://react.dev/) +
  [Tailwind CSS](https://tailwindcss.com/) for the frontend.
- [Express](https://expressjs.com/) + [tsx](https://github.com/privatenumber/tsx)
  for the backend.

[ffmpeg-static]: https://github.com/eugeneware/ffmpeg-static
[ffprobe-static]: https://github.com/eugeneware/ffprobe-static
