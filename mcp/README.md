# Clipper Cowboy MCP

`clipper-cowboy-mcp` lets Codex and any other MCP client drive Clipper Cowboy
headlessly over stdio. It can inspect a project, search sources and clips,
smart-cut exports, update metadata, and optionally request OpenAI vision
analysis. The browser UI does not need to be open.

Media is never streamed through MCP. Tools exchange stable catalog IDs, local
paths, metadata, and job status. The server starts Clipper Cowboy's loopback API
automatically when an operational tool first needs it.

## One-command setup

From the Clipper Cowboy repository root:

```bash
npm run setup
```

This installs the app and MCP dependencies, builds both packages, and runs the
local readiness doctor. Requirements: Node 20+; ffmpeg and ffprobe are bundled.

Verify at any time:

```bash
npm run mcp:verify
npm run doctor
```

## Connect Codex

Add this to `~/.codex/config.toml`, replacing the absolute paths:

```toml
[mcp_servers.clipper-cowboy]
command = "node"
args = ["/ABS/PATH/TO/clipper-cowboy/mcp/dist/index.js"]

[mcp_servers.clipper-cowboy.env]
CLIPPER_ROOT = "/ABS/PATH/TO/clipper-cowboy"
CLIPPER_PROJECT_DIR = "/ABS/PATH/TO/YOUR/VIDEO-PROJECT"
```

Restart the MCP client. Call `setup_status`, then `project_summary` or
`list_sources`.

## Connect any MCP client

```json
{
  "mcpServers": {
    "clipper-cowboy": {
      "command": "node",
      "args": ["/ABS/PATH/TO/clipper-cowboy/mcp/dist/index.js"],
      "env": {
        "CLIPPER_ROOT": "/ABS/PATH/TO/clipper-cowboy",
        "CLIPPER_PROJECT_DIR": "/ABS/PATH/TO/YOUR/VIDEO-PROJECT"
      }
    }
  }
}
```

The transport is stdio. Do not configure an HTTP tunnel or public listener.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `CLIPPER_ROOT` | Absolute Clipper Cowboy repository path. | Resolved from the MCP build location. |
| `CLIPPER_PROJECT_DIR` | Absolute video project path for this MCP session. | The app's existing local configuration. |
| `CLIPPER_URL` | Existing loopback API to attach to. | `http://127.0.0.1:47474` |
| `CLIPPER_PORT` | Port used when auto-starting the API. | `47474` |
| `CLIPPER_AUTOSTART` | Start the verified local API when needed. | `true` |
| `CLIPPER_MCP_DEBUG` | Send redacted service logs to stderr. | `false` |

No API key belongs in a tool call or public MCP example. Clipper Cowboy's
optional OpenAI key remains in its ignored local `.env`/Settings configuration;
MCP reports only `openai_configured: true|false`.

## Tools

| Tool | Purpose |
|---|---|
| `setup_status` | Side-effect-free readiness and configuration report. |
| `setup_environment` | With `confirm_install:true`, run lockfile-based install/build commands; optionally create the configured project directory. |
| `project_summary` | Counts, project paths, missing media, and AI readiness. |
| `list_sources` | Search safe project source videos and obtain source IDs. |
| `get_source` | Exact duration, metadata, and exported ranges for one source. |
| `list_clips` | Search exported clips and obtain safe handoff paths. |
| `get_clip` | Full metadata and output path for one clip. |
| `list_metadata_catalogs` | Character, scene, and object IDs. |
| `export_clip` | Smart-cut one source range into `clips/`; supports background jobs. |
| `update_clip_metadata` | Update descriptive metadata without moving/deleting media. |
| `analyze_source_with_openai` | Optional frame analysis with explicit external-upload confirmation. |
| `check_job` | Poll setup, export, or analysis started with `wait:false`. |

There is intentionally no arbitrary file read/write, settings/key tool, shell
tool, delete, trash, reveal, or unrestricted output path.

## Example agent workflow

```jsonc
setup_status {}
project_summary {}
list_sources { "query": "showdown" }
get_source { "source_id": "0123456789abcdef" }

export_clip {
  "source_id": "0123456789abcdef",
  "in_seconds": 4.2,
  "out_seconds": 11.8,
  "name": "Showdown Closeup",
  "tags": ["showdown", "closeup"],
  "wait": false
}

check_job { "job_id": "<returned UUID>" }
```

The completed export contains:

```json
{
  "handoff": {
    "input_path": "/project/clips/Showdown_Closeup.mov",
    "suggested_stem_output_dir": "/project/derived/stems/Showdown_Closeup",
    "next_tool": "stem-studio.separate_stems"
  }
}
```

Pass those two paths to Stem Studio's official MCP server. Neither repository
needs access to the other's configuration or credentials.

## Security behavior

- Source, clip, and catalog mutations accept 16-hex IDs—not caller paths.
- All returned media paths are canonicalized; traversal and symlink escapes are
  rejected.
- Exports always go to the configured `clips/` directory with collision-safe
  filenames.
- Long mutations run serially so two agents cannot race exports.
- Tool errors and service diagnostics redact recognized token shapes and secret
  environment values.
- OpenAI analysis requires `confirm_external_upload: true` because sampled
  frames leave the machine. No other MCP tool uploads media.
- The managed API binds to `127.0.0.1` and must identify itself as Clipper
  Cowboy API v1 before MCP attaches.
- An MCP-managed API receives a random per-process capability token; unrelated
  local processes cannot call its broad UI/settings/filesystem routes.
- Closing the MCP server stops its managed API. Individual exports are not
  advertised as cancellable because cancellation cannot yet be guaranteed when
  MCP attaches to an independently running UI server.

## Development

```bash
cd mcp
npm install
npm run typecheck
npm test
npm run smoke
```

The smoke suite launches the real built stdio server from an unrelated working
directory, verifies all tools, rejects a traversal-shaped ID, fails on non-JSON
stdout, and proves a fake secret never appears in the transcript. It then creates
a temporary synthetic video, auto-starts the managed API, probes and exports a
real clip, verifies the catalog entry and Stem Studio handoff, and deletes the
fixture. It never reads user media or requires a network/API key.

## Troubleshooting

- `DEPENDENCIES_MISSING`: run `npm run setup` in the repository root.
- `SERVICE_MISMATCH`: another app occupies the configured port; choose another
  `CLIPPER_PORT` or stop that app.
- `PROJECT_MISMATCH`: an existing Clipper server uses a different project;
  align `CLIPPER_PROJECT_DIR` or stop the old server.
- `OPENAI_NOT_CONFIGURED`: add your own key through the local Settings UI. Never
  paste it into an MCP call.
- A completed job disappears after one hour by design; the exported media and
  catalog entry remain on disk.
