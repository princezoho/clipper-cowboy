# Clip Cataloger

A local web app for triaging AI-generated montage videos. Drop sources into a project folder, let GPT-4o auto-cut + caption + character-tag every scene, then walk a review queue and approve / skip / edit each clip. Exports keep bit-for-bit source quality.

## What it does

- **Project folder model** — one folder is one project. Sources at the root, exported clips in `clips/`, character library in `characters/`, plus a `shotlist.md` + `shotlist.csv` regenerated on every change. Open the folder anywhere (Finder, Premiere, another machine) and the whole project is portable.
- **Pool grid** — every video at the project root shown as a thumbnail with a "✓ N clips exported" badge.
- **Auto-cut review queue** — click ⚡ on a source: AI runs scene detection, captions every segment in parallel (4-way), and hands you a queue. Walk it with `A` (approve & export), `S` (skip), `J/K` (prev/next), `R` (re-caption with new in/out).
- **Manual editor** — fullscreen player, frame-accurate scrubbing, in/out handles, scene-marker timeline. Same hotkeys as before.
- **Character library + AI character recognition** — define characters once with reference images, and GPT-4o tags every clip that contains them. Unknown faces get flagged as cards with name / connect-to-existing / ignore actions.
- **Tag suppression** — generic style tags (`animation`, `cartoon`, `illustration`, etc.) are filtered out so the catalog stays signal-only.
- **Three export modes** — Clip / Source / Clip+Source bundle. Bundles use APFS clones, so the source-copy is instant and zero-disk-cost on macOS.
- **Smart-cut export** — preserves the source's exact quality. If your in/out land on keyframes, it stream-copies (truly bit-identical). Otherwise it stream-copies the middle and re-encodes only the trim-edge GOPs at lossless settings, then concats.
- **Library grid** — exported clips with editable name/description/tags/characters and a Clip / Source / Side-by-side preview that loops the in→out range.

## Setup

Requires Node 18+ (tested with Node 20+). `ffmpeg` and `ffprobe` are bundled via `ffmpeg-static` and `ffprobe-static`, so you do not need a system install.

```bash
cp .env.example .env
# edit .env — at minimum set OPENAI_API_KEY and PROJECT_DIR
npm install
npm run dev          # dev mode: vite UI on :5173, watch-mode API on :5174
```

For day-to-day use (no Vite, just one process):

```bash
npm run build        # build the React bundle into dist/
npm start            # serve API + UI on :5174 from dist/
# open http://localhost:5174
```

### One-click on macOS

`Clip Cataloger.command` lives in the repo root. Double-click it in Finder — it runs `npm install` if needed, builds the UI if `dist/` is stale, starts the server, and opens your browser. Press `Ctrl+C` in the Terminal window to stop the app.

If macOS warns "cannot be opened because it is from an unidentified developer," right-click the file → Open → Open. You only need to do this once.

### Configuration

Single env var: `PROJECT_DIR` (the project folder). If unset, defaults to `~/ClipCataloger`.

| Var              | Required | Description                                       |
| ---------------- | -------- | ------------------------------------------------- |
| `OPENAI_API_KEY` | for AI   | GPT-4o calls (caption, character match, auto-cut) |
| `PROJECT_DIR`    | no       | Project folder. Defaults to `~/ClipCataloger`.    |
| `PORT`           | no       | API + UI port. Defaults to `5174`.                |

## Project folder layout

```
PROJECT_DIR/
├── *.mp4                      # source montages at root (the "pool")
├── clips/                     # exported clips (the "library")
│   Cartoon_Band_Performing.mp4
│   Cartoon_Band_Performing.source.mp4   # bundle source clones (APFS)
├── characters/                # character library (browsable)
│   Buck/
│     character.json
│     refs/001.jpg
│   Marshall_Roy/
│     ...
├── shotlist.md                # regenerated on every export/edit/delete
├── shotlist.csv               # same data, machine-readable
└── .clipcataloger/            # hidden caches + sidecars (safe to delete)
    clip-meta/<id>.json
    scenes/<sourceId>.scenes.json
    thumbs/lib-<id>.jpg, pool-<id>_*.jpg
    auto-cuts/<sourceId>.json  # per-source review-queue state
    caption-tmp/...            # 1h TTL
    durations.json
```

## Hotkeys

### Manual editor

| Key        | Action                                            |
| ---------- | ------------------------------------------------- |
| `Space`    | Play / pause                                      |
| `J/K/L`    | Reverse / pause / forward (1×)                    |
| `I` / `O`  | Set in / out at current playhead                  |
| `←` / `→`  | Step one frame (hold Shift for 10)                |
| `↑` / `↓`  | Previous / next detected scene (auto-fills meta)  |
| `Enter`    | Export the current selection                      |
| `Esc`      | Close the editor                                  |

### Auto-cut review queue

| Key       | Action                                                    |
| --------- | --------------------------------------------------------- |
| `A` / `Enter` | Approve & export current candidate, advance to next   |
| `S`       | Skip current candidate (remembered until "Re-analyze")    |
| `J` / `K` | Previous / next candidate                                 |
| `R`       | Re-caption current candidate with current in/out          |
| `Esc`     | Exit review mode                                          |

In a text input, `Enter` only triggers approve when held with `⌘` / `Ctrl`.

## Quality / precision notes

The export route in [`server/smartcut.ts`](server/smartcut.ts) probes the source for keyframe positions, then:

1. **Both endpoints already on keyframes** → single `ffmpeg -ss in -to out -c copy`. Bit-identical.
2. **Otherwise** → up to three segments: a head re-encoded `[in .. nextKeyframe]`, the middle stream-copied `[..]`, and a tail re-encoded `[prevKeyframe .. out]`. The re-encode uses lossless settings matched to the source codec (`libx264 -qp 0` for H.264, `libx265 lossless=1` for HEVC, `prores_ks` for ProRes). Audio is re-encoded only on the edge segments to match.

This means the **body** of every exported clip is bit-identical to the source, the **edges** are at most a fraction of a second of lossless re-encode, and the **cuts are exact** to the in/out you set.

For bundle/source-only exports, the source is copied with `cp -c` (APFS `clonefile(2)`) — instant, zero data written, copy-on-write. Falls back to a regular byte copy on non-APFS volumes.
