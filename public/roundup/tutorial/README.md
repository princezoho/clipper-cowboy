# Roundup real-UI tutorial artifacts

Captured 12 July 2026 from the live Clipper Cowboy Roundup and Library →
Universal Clipper UIs at a 1440×900 Chromium viewport.

Data boundary:

- **Fundrop is real and read-only.** Only aggregate status is shown: 85 regular
  entries checked, 80 supported media files, 1,177,011,058 bytes.
- **Every visible media filename is synthetic.** Tracking uses a one-second
  silent WAV under `<home>/roundup-demo-fixture/`. Universal Clipper uses
  generated color-test MP4s in the isolated project
  `/tmp/roundup-universal-tutorial-20260712`.
- No Fundrop file was copied, renamed, moved, overwritten, deleted, revealed,
  transcoded, or uploaded.
- Universal Clipper executed only against the isolated generated MP4 fixtures.
  No stem separation, external upload, model setup, Finder reveal, or Adobe
  project action was performed.

## Artifacts

- `01-fundrop-watched.png` — captured live healthy watcher with Fundrop
  enabled. Readiness was re-verified with Downloads + fundrop Watched on the
  FSEvents backend; other broad roots remain inventory-only.
- `02-fundrop-inventory-aggregate.png` — real aggregate Fundrop inventory;
  the filename list was intentionally hidden before capture.
- `03-demo-seeded-export-preview.png` — synthetic silent WAV with its AirTag,
  collision-safe export preview, and manifest-only stems control.
- `04-two-watched-hops.png` — persisted watcher events for the two synthetic
  external moves.
- `05-old-path-airtag-history.png` — lookup by the original path, current path,
  stable AirTag `24e4a0ad-8936-4855-bb54-c2663421c530`, and full trail.
- `06-copy-and-reveal-controls.png` — Copy path success toast and the untriggered
  Reveal in Finder control.
- `07-export-and-stems-preview.png` — current export preview versus explicit
  stems-handoff preparation.
- `08-universal-selection.png` — two generated Library clips selected with the
  actual Universal Clipper action available.
- `09-universal-grouped-preview.png` — grouped source preview, deterministic
  adjacent names, smart-cut ranges, safety copy, and explicit stem handoff.
- `10-universal-package-ready.png` — completed package state with Reveal, Copy
  folder path, HTML/CSV clip-sheet, and returned-stem validation controls.
- `11-universal-clip-sheet.png` — generated HTML clip sheet for the two
  synthetic selections and their sibling planned stems.
- `roundup-walkthrough.webm` — original 13.5-second Playwright recording.
- `roundup-walkthrough.mp4` — H.264 browser-compatible conversion.
- `roundup-walkthrough-preview.gif` — compact 720×450, 6 fps animated preview.

## Synthetic trail

1. `<home>/roundup-demo-fixture/roundup-demo-original.wav`
2. `<home>/roundup-demo-fixture/hop-one/roundup-demo-hop-one.wav`
3. `<home>/roundup-demo-fixture/hop-two/roundup-demo-current.wav`

The final fixture was intentionally left at step 3 so the recorded lookup
remains reproducible.

## Integrity evidence

Before and after Fundrop snapshots were identical:

- regular files: `85`
- supported media: `80`
- media bytes: `1,177,011,058`
- metadata digest:
  `ee8c32b57af7d7f613472b86e1f1d2382540c1fa0d9f22e32bd3e7c3495ca738`

The digest covers each supported media file's relative path, size, nanosecond
mtime, and inode. It does not read media payloads.

## Universal Clipper evidence and boundary

The recorded synthetic package contains:

- one copied full source and two real adaptive smart-cut clip outputs;
- one flat `media/` directory with deterministic adjacent names;
- `clip-sheet.json`, `clip-sheet.csv`, and `README.html`;
- `stem-handoff.json` and an empty, contained `stem-inbox/`;
- Reveal package, Copy folder path, Open clip sheet, Download CSV, and Validate
  returned stems controls.

No WAV files appear in `media/` because this fixture had no validated existing
stems and no external separator was run. Missing stems remain planned handoff
records until exact returned files pass containment, identity, and duration
validation.

Future-only boundaries remain native Adobe UXP/CEP insertion or virtual drag,
plus authoritative FCPXML/EDL after frame-rate and source-timecode metadata is
available and import behavior is tested.
