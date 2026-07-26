# Universal Clipper → stems → Premiere

Universal Clipper creates a collision-safe package under:

`PROJECT_DIR/derived/universal-clipper/<unique-package>/`

Premiere Pro 25.6+ uses the native UXP panel in `adobe-premiere/`. The panel
retrieves packages by validated package UUID, inspects the open project, and
imports only missing canonical media paths. Reveal in Finder remains the
fallback; browser drag is not used.

## Package layout

```text
premiere-handoff/
├── media/
│   ├── scene137.mov
│   ├── scene137__DIALOGUE.wav
│   ├── scene137__MARRIED.wav
│   ├── scene137__MUSIC.wav
│   ├── scene137__SFX.wav
│   ├── scene137__clip-01.mov
│   ├── scene137__clip-01__DIALOGUE.wav
│   ├── scene137__clip-01__MARRIED.wav
│   ├── scene137__clip-01__MUSIC.wav
│   └── scene137__clip-01__SFX.wav
├── stem-inbox/
├── clip-sheet.json
├── clip-sheet.csv
├── README.html
└── stem-handoff.json
```

Only validated, real stem files appear in `media/`; Clipper never creates
placeholder WAVs. The primary path uses the official Stem Studio MCP. It
separates each full source into a unique job directory beneath
`PROJECT_DIR/derived/stems/`, validates DIALOGUE/MUSIC/SFX/MARRIED, derives
clip-aligned stems from those full-source files, and publishes the complete
batch into `media/` with exclusive creation. The contained `stem-inbox/` and
handoff manifest remain for package diagnostics; production execution does not
accept arbitrary returned paths through an API.

Full-source stems start at source time 0 and share duration, sample rate, and
channel count. Clip stems start at clip time 0. Their boundaries are the clip
sheet's source in/out rounded to the validated full stem's sample rate, so all
roles use the same sample indices. Returned full-source duration allows at most
0.25 seconds of container/audio tail; derived clip audio must match within two
samples or 0.05 seconds, whichever is larger. Seconds remain canonical because
the catalog does not yet retain authoritative source timecode/frame-rate
metadata.

## Execution states

- `not_requested`: media package exists; no model was run
- `checking_setup`: side-effect-free `setup_status`
- `setup_required`: user must finish environment/model setup in Stem Studio;
  Clipper stops and never calls `setup_environment`
- `running` / `validating`: serialized official MCP job and local validation
- `ready`: the complete flat stem set is published and Premiere import is
  enabled
- `cancelled`, `interrupted`, or `error`: no partial batch is advertised;
  retry starts in a new unique derived output directory

High is selected by default. Max requires an explicit quality choice and a
separate licensing confirmation.

## Video fidelity

The existing smart-cut pipeline is reused. It stream-copies when both endpoints
land on keyframes. Otherwise it losslessly re-encodes edge sections (or the
whole short range) to honor the selected marks. This is high fidelity but can
change codec characteristics or file size; “stream-copy” does not imply
frame-accurate arbitrary cuts away from keyframes.

## Premiere package API

Authenticated loopback endpoints expose recent packages, one validated package
manifest, stem execution, and per-project import acknowledgements. They accept
package UUIDs and known asset IDs only—never arbitrary filesystem paths. The
UXP panel:

1. reads canonical paths from the server-validated package
2. traverses the open Premiere project with `getMediaFilePath()`
3. previews Existing / Will import / Unresolved / Invalid
4. creates shallow `Universal Clipper / <source-name>` bins
5. calls `Project.importFiles()` only for missing assets
6. optionally places one selected clip group at the active playhead only after
   an explicit click

Premiere UXP 25.6 does not document a project-item comment/XMP writer, so
AirTag/group relationships remain in Clipper's local mapping instead of being
claimed as embedded Premiere metadata.

No `.prproj`, EDL, or FCPXML is generated. Clipper does not recover missing
media or edit project files directly.

Absolute source paths are included in the local JSON/CSV for traceability.
Redact those fields before sharing a package outside the workstation.

Official connector and Adobe API details: `docs/INTEGRATIONS.md`.
