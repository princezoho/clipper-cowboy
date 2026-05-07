# Clip Cataloger

A local web app for triaging AI-generated montage videos. Drop sources into a pool folder, scrub through them, set in/out, accept (or override) AI scene suggestions and AI-generated names/tags, and export bit-for-bit identical clips into a stock-style library.

## What it does

- **Pool grid** — see every video in your `POOL_DIR` as a clickable thumbnail.
- **Editor overlay** — fullscreen player with frame-accurate scrubbing, in/out handles, and a timeline marked up with detected scene boundaries.
- **Scene cycling** — `↑`/`↓` jump through detected scenes; the current scene's in/out is preselected, you can drag it tighter, the AI caption auto-populates.
- **AI auto-fill** (GPT-4o vision) — three sample frames per scene are sent to OpenAI, you get back a name, one-line description, and a few tags.
- **Smart-cut export** — preserves the source's exact quality. If your in/out land on keyframes, it stream-copies (truly bit-identical). Otherwise it stream-copies the middle and re-encodes only the trim-edge GOPs at lossless settings, then concats — so the body is bit-identical to the source and only the fractional-second edges are touched.
- **Library grid** — exported clips show up here with editable name/description/tags, all stored as plain sidecar JSON next to the video files.

## Setup

Requires Node 18+ (tested with Node 20+). `ffmpeg` and `ffprobe` are bundled via `ffmpeg-static` and `ffprobe-static`, so you do not need a system install.

```bash
cp .env.example .env
# edit .env and set OPENAI_API_KEY, POOL_DIR, LIBRARY_DIR
npm install
npm run dev
```

Then open <http://localhost:5173>.

If you don't set `POOL_DIR` / `LIBRARY_DIR`, the app creates `~/ClipCataloger/pool` and `~/ClipCataloger/library` on first run.

If `OPENAI_API_KEY` is missing, the app still works — you just lose the AI auto-fill button and have to fill in clip names yourself.

## On-disk layout

```
POOL_DIR/                  # drop source montages here
  myclip.mp4
  another.mov
  .cache/                  # thumbnails + cached scene detection results
    <id>.scenes.json

LIBRARY_DIR/               # exported clips
  Drone_Shot_Sunset_Coast.mp4
  Cafe_Interior_Wide.mov
  .meta/                   # one JSON sidecar per exported clip
    <clip-id>.json
  .cache/                  # thumbnail cache
```

The `.meta/<id>.json` sidecar holds the canonical metadata: name, description, tags, source file, exact in/out, export mode (`stream-copy` / `smart-cut` / `reencode-fallback`), and timestamps. Editing tags from the Library grid writes back to this file.

## Hotkeys (in the editor)

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `J` / `K` / `L` | Reverse / pause / forward (1×) |
| `I` / `O` | Set in / out at current playhead |
| `←` / `→` | Step one frame (hold Shift for 10) |
| `↑` / `↓` | Previous / next detected scene (auto-fills name + tags) |
| `Enter` | Export the current selection |
| `Esc` | Close the editor |

In a text input, `Enter` only triggers export when held with `⌘` / `Ctrl`.

## Quality / precision notes

The export route in [`server/smartcut.ts`](server/smartcut.ts) probes the source for keyframe positions, then:

1. **Both endpoints already on keyframes** → single `ffmpeg -ss in -to out -c copy`. Bit-identical.
2. **Otherwise** → up to three segments: a head re-encoded `[in .. nextKeyframe]`, the middle stream-copied `[..]`, and a tail re-encoded `[prevKeyframe .. out]`. The re-encode uses lossless settings matched to the source codec (`libx264 -qp 0` for H.264, `libx265 lossless=1` for HEVC, `prores_ks` for ProRes). Audio is re-encoded only on the edge segments to match.

This means the **body** of every exported clip is bit-identical to the source, the **edges** are at most a fraction of a second of lossless re-encode, and the **cuts are exact** to the in/out you set.

## Scope (v1)

This build covers exactly the v1 scope from the plan: a single library destination, no library search/filter, no auto-clipping, no batch queue. Adding a "feeds" abstraction for multiple destination folders later is straightforward — `LIBRARY_DIR` becomes a list and the export route picks the active one.
