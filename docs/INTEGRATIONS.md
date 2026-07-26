# Official integrations

## Stem Studio MCP

Universal Clipper executes stems only through Stem Studio's official stdio MCP
server. Clipper does not vendor the worker into this flow, invoke
`setup_environment`, install dependencies, or download models.

Configure one absolute entry in **Settings → Stem Studio MCP connector**. Clipper
canonicalizes the file and stores only that path in
`PROJECT_DIR/.clipcataloger/integrations.json` with mode `0600`; no credentials
or inherited environment are stored. Two official shapes are accepted:

- installed macOS launcher:
  `/Applications/Stem Studio.app/Contents/Resources/mcp/stem-studio-mcp`
- source checkout module: `<stem-studio>/mcp/dist/index.js`

The packaged launcher must have the official adjacent distribution descriptor,
module, package marker, and Electron executable. A source module must have an
adjacent `mcp/package.json` whose name, version, main, and bin identify
`stem-studio-mcp`. Symlinks, generic scripts, arbitrary executables, and other
JavaScript files are rejected. For a source checkout, build Stem Studio's MCP
itself before choosing `mcp/dist/index.js`; Clipper does not install it.

`STEMSTUDIO_MCP_ENTRY` remains a legacy launch-time fallback, with the same
validation, when no project-local connector path is saved.

The child receives a fresh fixed allowlist only:

- basic process/runtime values: `PATH`, `HOME`, temp and locale variables
- official Stem Studio values: `STEMSTUDIO_ROOT`, `STEMSTUDIO_PYTHON`,
  `STEMSTUDIO_RESOURCES`, `STEMSTUDIO_USER_DATA`,
  `STEMSTUDIO_USER_DATA_FOLDER`, `STEMSTUDIO_CACHE`,
  `STEMSTUDIO_WINDOWS_PROFILE`
- fixed download guards: `HF_HUB_OFFLINE=1` and
  `TRANSFORMERS_OFFLINE=1`, so an incomplete cache fails instead of fetching

Clipper never forwards `OPENAI_API_KEY`, `CLIPPER_API_TOKEN`, proxy variables,
or the parent environment wholesale. Stdout must remain JSON-RPC; bounded,
redacted stderr is diagnostic-only.

### Execution contract

1. `initialize`, `tools/list`
2. `setup_status` (side-effect free)
3. Stop with `setup_required` when Python, dependencies, or models are absent
4. `separate_stems` with a validated package full-source path, a unique output
   beneath `PROJECT_DIR/derived/stems/`, `wait:false`, and High by default
5. Poll `check_job`; use `cancel_job` only for an explicit cancellation
6. Validate every returned path is a regular non-symlink file inside the fixed
   output directory
7. Validate DIALOGUE/MUSIC/SFX/MARRIED duration, sample rate, and channel count
8. Derive clip stems from each validated full-source stem using the clip
   sheet's exact rounded sample in/out boundaries
9. Publish the complete batch with exclusive creation into the package's flat
   `media/` directory; update JSON/CSV/HTML and AirTag lineage only after the
   full batch succeeds

The UI reports connector state separately as **Not configured**,
**Setup required**, **Ready**, or **Live fixture verified**. The final state is
shown only when a generated High-quality fixture has completed output and
source-preservation validation for the currently configured entry.

High is the strongest automatic recommendation. Max is sent only after the user
chooses Max and separately confirms its upstream licensing requirement.

Jobs are serialized. Cancellation asks the official server to terminate its
job. If Clipper or the MCP process exits, an active job becomes `interrupted`;
retry creates a new isolated output directory because remote process recovery
cannot be guaranteed.

That cancellation control exists only in the UI server that spawned and owns
the Stem Studio session. Clipper's standalone agent MCP does not expose a
`cancel_job` for work owned by an independently running UI server; doing so
would imply lifecycle control it cannot guarantee.

The official Stem Studio 1.1.0 source checkout's MCP 1.0.0 contract, verified
on 14 July 2026, exposes `probe_media`, `separate_stems`, `check_job`,
`cancel_job`, `setup_status`, and `setup_environment`. Clipper intentionally
never calls the last tool.

### Operator-run source setup

`setup_environment` is an operator action, not a Clipper action. For a source
checkout with a built `mcp/dist/index.js`, register that module in an MCP client
and manually call:

1. `setup_environment` with `{ "wait": true }`
2. `setup_status` with `{}`

The first call creates the checkout's `.venv`, upgrades pip, and installs
`python/requirements.txt`. The documented first-run dependency download is up
to roughly 2 GB, mostly PyTorch, and can take several minutes. A successful
status reports `ready: true`, `pythonExists: true`, and
`depsImportable: true`.

Environment setup creates the model-cache directory but does not prove that a
neural checkpoint is cached. Before using Clipper's offline-guarded connector,
the operator must run one short synthetic Stem Studio separation with
`quality: "high"` and the TIGER engine. That first High run downloads the
Apache-2.0 TIGER-DnR checkpoint (documented at about 17 MB); later High runs use
the cache. Do not choose Max for normal setup: Max adds the MVSEP engine and
its separately reviewed upstream checkpoints (about 54 MB each, with upstream
personal-use/unlicensed terms) and remains behind Clipper's explicit Max
licensing confirmation.

## Adobe Premiere Pro UXP

The native panel is in `adobe-premiere/` and targets Premiere Pro **25.6+**
(Premiere 25.6 embeds UXP 8.1). The implementation uses Adobe's documented UXP
APIs:

- [`Project.getActiveProject`, `getRootItem`, `importFiles`, and
  `executeTransaction`](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/project)
- [`FolderItem.getItems` and
  `createBinAction`](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/folderitem)
- [`ClipProjectItem.getMediaFilePath`](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/clipprojectitem)
- [`SequenceEditor.createOverwriteItemAction`](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequenceeditor)

The manifest is version 5 and permits only
`http://127.0.0.1:47474`. The panel asks Clipper for a validated package ID; it
never accepts a network-provided arbitrary directory. It traverses the open
project, normalizes canonical media paths, uses stored package/AirTag mappings
only as a secondary match, previews all decisions, creates
`Universal Clipper / <source-name>` bins, and imports missing paths.

Premiere UXP 25.6 has no documented project-item comment/XMP metadata writer.
AirTag and group IDs therefore remain in the panel and Clipper's authenticated
local acknowledgement store. This limitation is not simulated as a successful
metadata write.

Timeline placement is an explicit, separate button. It uses one undoable
Premiere transaction at the active playhead for clip video plus
DIALOGUE/MUSIC/SFX; MARRIED is excluded. No timeline action occurs during
inspection or **Import missing**.

See `adobe-premiere/README.md` for install and use steps. Build and host mocks
can run without Adobe; actual loading still requires a local Premiere
installation and cannot be claimed from CI.
