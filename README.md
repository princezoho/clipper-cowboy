<p align="center">
  <img src="./public/logo.png" alt="Clipper Cowboy — cowboy hat over a film clip" width="120" />
</p>

# Clipper Cowboy

> Local-first triage and cataloging for AI-generated video clips.
> Drop in a folder of long montages, mark in/out points with AI assistance,
> export at original quality, and build a searchable library — all on your
> machine.

<!-- TODO: add a screen recording / GIF here. ~20s of: drop folder → open
     editor → set in/out → auto-fill → export → see in library. -->
<p align="center"><em>Demo recording coming soon.</em></p>

## Why

AI video tools spit out long montages: a handful of brilliant 3-second shots
buried in minutes of filler. You want the good moments saved as named, tagged
clips you can pull into Premiere a year from now. Premiere itself is overkill
for this triage step, and cloud video tools want to either re-encode your
footage into garbage or upload it somewhere. Clipper Cowboy is a single
single-purpose local web app for this exact workflow — fast scrubbing,
frame-accurate in/out, lossless smart-cut export, and an honest catalog.

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

## Requirements

- Node 20+ (Node 22 recommended)
- `ffmpeg` and `ffprobe` are bundled via [`ffmpeg-static`][ffmpeg-static] and
  [`ffprobe-static`][ffprobe-static] — no system install needed.
- macOS, Linux, or Windows. A few convenience features ("Reveal in Finder",
  APFS-clone source-bundle exports) are macOS-only — everything else works
  everywhere.

## Quick start

```bash
git clone https://github.com/your-org/clipper-cowboy.git
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

All settings live in a local `.env` file. The first-run wizard writes this
for you, so you typically never need to touch it.

| Var              | Required | Description                                                              |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `PROJECT_DIR`    | no       | Project folder. Defaults to `~/ClipCataloger`.                           |
| `OPENAI_API_KEY` | for AI   | GPT-4o calls (clip captioning, character recognition). Optional.         |
| `PORT`           | no       | Production server port. Defaults to `47474`.                             |

See [`.env.example`](.env.example) for a documented template.

## Hotkeys

### Editor

| Key            | Action                                  |
| -------------- | --------------------------------------- |
| `Space`        | Play / pause                            |
| `J` / `K` / `L`| Reverse / pause / forward (1×)          |
| `I` / `O`      | Set in / out at current playhead        |
| `←` / `→`      | Step one frame (hold `Shift` for 10)    |
| `Enter`        | Export the current selection            |
| `Esc`          | Close the editor                        |

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
├── src/                # Vite + React + Tailwind frontend
│   ├── views/          # Pool, Library, Editor, Onboarding, Settings…
│   ├── components/     # Video player, timeline, meta form…
│   └── lib/            # API client, save-state store, hooks
├── public/             # static assets served by Vite (logo.png, mockups/)
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
