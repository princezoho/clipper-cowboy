# Stem Studio integration

Clipper Cowboy works with [wassermanproductions/stem-studio](https://github.com/wassermanproductions/stem-studio)
through both projects' official local MCP servers. The repositories remain
independent: no source is copied, no service is exposed to the network, and no
credentials are exchanged.

Stem Studio is Apache-2.0 software by Sam Wasserman. Clipper Cowboy merely calls
its documented MCP interface; Stem Studio is not bundled or redistributed here.

## Data contract

Given a configured `PROJECT_DIR`:

- Clipper Cowboy exports accepted media to `PROJECT_DIR/clips/`.
- The agent passes one exported clip path to Stem Studio's `separate_stems` tool.
- Stem Studio writes results to
  `PROJECT_DIR/derived/stems/<clip-basename>/`.
- Neither tool may read the other repository's `.env`.
- External tools must not modify `PROJECT_DIR/.clipcataloger/`.

For `scene12.mov`, Stem Studio produces:

```text
PROJECT_DIR/derived/stems/scene12/
├── scene12_DIALOGUE.wav
├── scene12_MUSIC.wav
├── scene12_SFX.wav
├── scene12_MARRIED.wav
└── scene12_STEMS.mov       # optional multitrack video
```

## Automatic UI workflow

For a first use, check **Split audio stems** while exporting. Clipper opens a
local setup sheet where you choose a trusted Stem Studio checkout in Finder.
Clipper verifies the selected repository and MCP identity before use. Selecting
a checkout is a trust decision: its MCP and Python worker execute locally with
your user account's filesystem permissions. Advanced setup remains available in
**Audio splitting setup** in Settings (or through `CLIPPER_STEM_STUDIO_ROOT`).

For a **Clip** or **Clip + Source** export, check **Split audio stems** and
choose:

- **Fast** — one TIGER pass; recommended on CPU.
- **High** — multi-pass separation; recommended on Apple MPS or CUDA.
- **Max** — TIGER plus MVSEP; slowest and may download additional weights.

Max is never selected automatically. Stem Studio's source describes its MVSEP
upstream/checkpoints as personal-use or unlicensed; assess the rights required
for your own use before choosing Max.

The foreground export completes first and returns immediately. The API process
then runs one stem job at a time, so queued neural work does not block editing
or later clip exports. Progress appears globally under **Stems**. Completed
files are written in a private `.jobs/` staging folder, checked for containment
and expected delivery names, then published atomically to the final folder.

Job summaries persist across restarts, but Stem Studio's inner jobs do not.
Clipper marks previously queued/running jobs `interrupted` after a restart; it
does not claim they resume. When Clipper is attached to an independently
running UI server, it exposes job status but no cancellation operation: it
cannot safely guarantee ownership of that server's worker lifecycle. Do not
assume a job can be stopped through Clipper until an explicitly documented,
lifecycle-safe cancellation design exists.

Optional configuration:

```dotenv
CLIPPER_STEM_STUDIO_ROOT=/ABS/PATH/TO/stem-studio
CLIPPER_STEM_STUDIO_PYTHON=/OPTIONAL/PATH/TO/python
CLIPPER_STEM_STUDIO_CACHE=/OPTIONAL/PATH/TO/models
CLIPPER_STEMS_TIMEOUT_MINUTES=360
```

On macOS, Clipper automatically reuses an existing Stem Studio desktop
environment under Application Support when present. It never calls
`setup_environment`; install or repair dependencies from Stem Studio itself.
The first TIGER run may download model weights.

## Install Clipper Cowboy's MCP server

From this repository:

```bash
npm run setup
```

Register `mcp/dist/index.js` and an absolute `CLIPPER_PROJECT_DIR` using the
Codex or generic-client example in [`../mcp/README.md`](../mcp/README.md).
Clipper's `export_clip` result is the authoritative bridge between the tools.

## Install Stem Studio's MCP server

Follow Stem Studio's own requirements first: Node 20+, Python 3.10+, and system
`ffmpeg`/`ffprobe`.

```bash
git clone https://github.com/wassermanproductions/stem-studio.git
cd stem-studio/mcp
npm install
npm run build
```

The first neural separation also needs Stem Studio's Python environment and
model cache. Its MCP tools provide `setup_status` and `setup_environment`; keep
those dependencies and model files inside Stem Studio's own locations.

## Connect Codex

Add this to `~/.codex/config.toml`, replacing both absolute paths:

```toml
[mcp_servers.stem-studio]
command = "node"
args = ["/ABS/PATH/TO/stem-studio/mcp/dist/index.js"]

[mcp_servers.stem-studio.env]
STEMSTUDIO_ROOT = "/ABS/PATH/TO/stem-studio"
STEMSTUDIO_PYTHON = "/ABS/PATH/TO/stem-studio/.venv/bin/python"
```

Restart the MCP client after editing its configuration. Other MCP clients can
launch the same `node .../mcp/dist/index.js` stdio command with the same optional
environment variables.

## Agent workflow

1. In Clipper Cowboy, run `setup_status {}`, `list_sources`, and `export_clip`.
   Use the completed export's `handoff.input_path` and
   `handoff.suggested_stem_output_dir`—do not guess filenames.
2. In Stem Studio, run `setup_status {}`. If it is not ready, run
   `setup_environment { "wait": false }` and poll `check_job`.
3. Run `probe_media` with Clipper's returned `handoff.input_path`.
4. Use Clipper's suggested output directory under
   `PROJECT_DIR/derived/stems/<clip-basename>/`.
5. Run Stem Studio's `separate_stems` with those input/output paths:

```json
{
  "input_path": "/absolute/project/clips/scene12.mov",
  "output_dir": "/absolute/project/derived/stems/scene12",
  "quality": "high",
  "multitrack_video": true,
  "wait": false
}
```

6. Poll `check_job` until completion. Do not put API keys, `.env` contents, or
   media bytes in MCP messages—only local paths and non-secret options.

Stem Studio does not require a hosted AI API key. Its neural models execute
locally. Clipper Cowboy's optional `OPENAI_API_KEY` remains private to Clipper
Cowboy and is unrelated to stem separation.

The automatic Clipper process launches Stem Studio with an environment
allowlist. It does not forward `OPENAI_API_KEY`, `CLIPPER_API_TOKEN`, proxy
credentials, or either repository's `.env` contents.

## Verification

In Stem Studio's `mcp/` directory:

```bash
npm run typecheck
npm test
npm run smoke
```

The smoke test requires the Stem Studio Python environment. Use its `stub`
engine for a fast plumbing test; use `tiger`/`mvsep` only after setup and model
downloads are complete.

In Clipper Cowboy, the isolated fake-MCP test exercises asynchronous export,
credential non-inheritance, staging validation, and atomic publication without
downloading a model:

```bash
npm run stem:smoke
```
