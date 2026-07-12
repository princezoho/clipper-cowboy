<p align="center">
  <img src="./public/app-icon.png" alt="Clipper Cowboy logo: a cowboy hat over a film clip" width="120" />
</p>

# Clipper Cowboy

> Keep every good shot in the world you’re building.

Clipper Cowboy turns a growing pile of AI-generated montages into reusable
coverage for your characters, scenes, and objects. When the next episode,
trailer, social cut, or pitch needs a shot, your world is ready to search—not
lost in raw video.

<p align="center">
  <img src="./docs/screenshots/landing-pool.png" alt="Clipper Cowboy's Pool view for reviewing video montages" width="90%" />
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#from-raw-generations-to-a-usable-world">See the workflow</a> ·
  <a href="#mcp-and-supporting-capabilities">MCP</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

## From raw generations to a usable world

### 1. Feed the Pool
Montages arrive in one review surface. See what has already produced clips,
what still needs attention, and return to a source without losing your place.

### 2. Save the good moments
Set precise in and out points, keep drafts as you work, and export named clips.
Each good moment becomes coverage you can use again instead of a memory of a
source file.

### 3. Teach the library your world
Connect clips to recurring characters, scenes, objects, tags, and reference
images. Optional AI can help with cataloging, but you decide what belongs in
the world.

### 4. Pull coverage for the next edit
Filter the library for the shots a cut needs, then preview and export the set
to Premiere or another NLE.

## Never lose a good shot again

The Pool above is your intake for a living library: a growing set of source
montages with clip counts, draft status, and saved regions visible at a glance.
Review only the material that still needs a decision; come back tomorrow and
continue from the same source.

## Build a cast, not a tag pile

![Editor view showing precise clip range controls and character, scene, object, name, description, and tag fields](./docs/screenshots/editor-clip-range.png)

A keeper can carry a character, a scene, an object, a name, and the context
that makes it usable later. Reference images help ground recurring people and
places; descriptive tags add the details. The result is a cast and a world you
can query, not a flat list of filenames.

## Start the next edit with coverage

Ask for a combination that matters to the cut, then collect the matching clips
instead of reopening every montage. For example, a catalog query might look
like:

```text
Character: Montoya + Scene: desert + Tag: horseback → 12 ready clips
```

That is a representative query, not a claim about your catalog. The point is
to make character, location, prop, action, and transition coverage available
when the next edit starts.

## Quick start

**Requirements:** Node 20+ (Node 22 recommended). `ffmpeg` and `ffprobe` are
bundled through [`ffmpeg-static`][ffmpeg-static] and
[`ffprobe-static`][ffprobe-static].

1. Clone this repository and enter it.
2. Run the local setup:

   ```bash
   npm run setup
   ```

3. Start the development app:

   ```bash
   npm run dev
   ```

Open <http://localhost:5173>. The first-run wizard creates or selects a project
folder and can optionally save an OpenAI key locally; clip review, cataloging,
and export work without a key.

For a single local server after a build:

```bash
npm start
# open http://localhost:47474
```

### macOS convenience launcher

`Clip Cataloger.command` is a **macOS-only** Finder launcher. It installs
dependencies when needed, builds stale UI assets, starts the local server, and
opens the browser. If Gatekeeper prompts, right-click the file and choose
**Open**. This convenience behavior is not a cross-platform installer.

## MCP and supporting capabilities

Clipper Cowboy's browser UI is the home for hands-on review, cataloging, and
selection. The included local MCP server can also let Codex and other compatible
agents inspect sources, search clips, update metadata, export clips, and request
explicitly confirmed OpenAI analysis. Start with the [MCP guide](./mcp/README.md).

Audio splitting is a built-in local capability. Its managed worker is adapted
from [Stem Studio](https://github.com/wassermanproductions/stem-studio) source;
it is not a separate app, checkout, or MCP dependency. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Privacy and security

Clipper Cowboy is local-first: the API binds to `127.0.0.1`, media and sidecar
metadata live in your project folder, and no hosted account is required. OpenAI
features are optional and require an explicit configured key; MCP analysis
requires confirmation before sampled frames leave the machine. Do not expose the
local API through a tunnel or reverse proxy. See [SECURITY.md](./SECURITY.md).

## Project status

Clipper Cowboy is a working local-first beta, not a hosted SaaS. Contributions,
bug reports, and thoughtful workflow feedback are welcome; see
[CONTRIBUTING.md](./CONTRIBUTING.md) and [SUPPORT.md](./SUPPORT.md).

## Detailed reference

### Configuration

Security-first defaults:

- **No API keys are committed in this repository.**
- `OPENAI_API_KEY` is optional; without it, AI features are disabled while core
  review, editing, cataloging, and export workflows continue.
- Settings save local configuration to an ignored `.env` file.
- The API binds to `127.0.0.1`; do not expose it through a tunnel or reverse
  proxy.

| Variable | Required | Description |
| --- | --- | --- |
| `PROJECT_DIR` | no | Project folder. Defaults to `~/ClipCataloger`. |
| `OPENAI_API_KEY` | no | Optional GPT-4o calls for captioning and recognition. |
| `PORT` | no | Production server port. Defaults to `47474`. |
| `CLIPPER_STEMS_TIMEOUT_MINUTES` | no | Per-job safety timeout; defaults to 360 minutes. |

See [`.env.example`](./.env.example) for the documented placeholder template.

### Background audio stems

Choose **Split audio stems** on a **Clip** or **Clip + Source** export. The
first use explicitly creates Clipper Cowboy's managed Python 3.11 environment,
installs the pinned Demucs engine, and downloads the Fast `htdemucs` model
before the checkbox is enabled. Clipper processes one local job at a time and
publishes verified outputs under
`PROJECT_DIR/derived/stems/`; a stem failure does not invalidate the clip
export. No hosted key is required for separation, and no keys are passed to the
audio process.

Fast uses `htdemucs`. High uses Demucs 4.0.1's fine-tuned `htdemucs_ft` model;
it is downloaded only after the user selects High for a job, which visibly
reports that download. Outputs are Dialogue, Music, and Effects / SFX:
Effects / SFX are best-effort residual effects after music is excluded.

### Architecture

1. **Import / indexing** — select `PROJECT_DIR`; Clipper scans source video and
   writes project-local sidecar state.
2. **Review loop** — use the React UI to annotate shots and adjust ranges.
3. **Optional AI pass** — server-side OpenAI calls run only when configured.
4. **Export pipeline** — a keyframe-aware exporter writes accepted clips to
   `clips/`.
5. **Catalog persistence** — clips, entities, drafts, and activity live in
   `.clipcataloger/` inside the project.

- **Frontend (`src/`)**: Vite + React 18 + Tailwind UI.
- **Backend (`server/`)**: Express API, local filesystem operations, and ffmpeg
  orchestration.
- **Platform notes**: macOS, Linux, and Windows are supported by the core
  stack. `Reveal in Finder` and APFS clonefile bundle exports are macOS-only;
  cross-platform polish is still welcome.

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
   `ffmpeg -ss in -to out -c copy`.
2. **Otherwise** → up to three segments are concatenated: a head re-encoded
   `[in .. nextKeyframe]`, the middle stream-copied `[..]`, and a tail
   re-encoded `[prevKeyframe .. out]`. The re-encode uses lossless settings
   matched to the source codec (`libx264 -qp 0` for H.264, `libx265
   lossless=1` for HEVC, `prores_ks` for ProRes). Audio is re-encoded only on
   the edge segments.

The exporter preserves frame-accurate in/out points. It stream-copies a
keyframe-aligned interior when available; trim edges may be losslessly
re-encoded, so an export should not be described as bit-identical as a whole.

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
- [Vite](https://github.com/vitejs/vite) +
  [React](https://github.com/facebook/react) +
  [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) for the frontend.
- [Express](https://github.com/expressjs/express) +
  [tsx](https://github.com/privatenumber/tsx)
  for the backend.

[ffmpeg-static]: https://github.com/eugeneware/ffmpeg-static
[ffprobe-static]: https://github.com/eugeneware/ffprobe-static
