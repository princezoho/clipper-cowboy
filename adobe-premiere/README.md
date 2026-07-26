# Universal Clipper for Adobe Premiere Pro

Native UXP panel for Premiere Pro **25.6 or newer** (UXP 8.1 in Premiere
25.6). It reads authenticated, loopback-only Universal Clipper package APIs and
uses Adobe's documented UXP DOM:

- `Project.getActiveProject()` and `Project.getRootItem()`
- `FolderItem.getItems()` / `createBinAction()`
- `ClipProjectItem.getMediaFilePath()`
- `Project.importFiles()`
- `SequenceEditor.createOverwriteItemAction()` only after the explicit
  **Add group at playhead** action

The panel never opens or edits a `.prproj` file directly and does not attempt
missing-media recovery.

## Development install

1. Install **UXP Developer Tools 2.2+** from Adobe Creative Cloud → All apps.
   If it is missing, this is the only action to take before continuing.
2. From this repository, run:

   ```bash
   npm run premiere:build
   ```

3. Enable Developer Mode in Premiere → Settings → Plugins, restart Premiere,
   then open UXP Developer Tools.
4. Choose **Add Plugin…** and select
   `adobe-premiere/dist/manifest.json`.
5. Start Premiere Pro 25.6+, open a disposable empty project, then load the
   plugin.
6. In Premiere choose **Window → UXP Plugins → Universal Clipper**.
7. Keep Clipper Cowboy running on `http://127.0.0.1:47474`. If the local API
   was started with `CLIPPER_API_TOKEN`, paste that process-local capability
   token into the panel; it is kept only in memory and is not embedded or
   saved.

The manifest permits only `http://127.0.0.1:47474`. For a deliberate custom
port, change both that exact manifest domain and the panel port before building;
do not broaden the permission to all network domains.

## Use

1. In Clipper Library, select clips and open **Universal Clipper**.
2. Click **Prepare media**.
3. Confirm local model execution, choose **High** (recommended), and click
   **Separate stems**. Max is available only after its separate licensing
   confirmation.
4. Wait for **Ready for Premiere**.
5. In the Premiere panel, connect and choose the package.
6. Review Existing / Will import / Unresolved / Invalid.
7. Click **Import missing**. The panel creates
   `Universal Clipper / <source-name>` bins and imports only canonical paths
   that are absent. Retrying is idempotent.
8. Optional: choose one imported clip group and explicitly click
   **Add group at playhead**. This uses one Premiere transaction to place the
   clip video and DIALOGUE/MUSIC/SFX at the same playhead time. MARRIED is
   excluded to avoid duplicate mixed audio.

## Current host limitations

- Premiere UXP 25.6 documents media-path reads and project-item IDs, but no
  project-item comment/XMP metadata writer. AirTag and group relationships stay
  in Clipper's local import acknowledgement store and remain visible in the
  panel.
- Timeline placement uses documented overwrite actions and is never automatic.
  Inspect the active sequence/playhead first; the operation is undoable through
  Premiere's transaction history.
- The plugin is build- and mock-tested in this repository. A real Adobe host is
  still required to validate installation and host-specific behavior.

## Local live-host validation status

On 14 July 2026, UXP Developer Tools 2.2.1 and Premiere Pro 26.2.2 were
detected running on the validation Mac. Lint, all 11 host/API tests, and the
distribution build passed, and `dist/manifest.json` retained its
loopback-only permission.

An isolated server on `127.0.0.1:47475` successfully listed and returned one
synthetic High-ready package with two groups and ten ready WAV assets, then was
stopped. This verifies the package API fixture only: the production manifest
intentionally permits port 47474, so it does not establish a live panel
connection.

Live loading remains pending: macOS denied Accessibility control to the
validation process, so it could not press **Add Plugin…** / **Load & Watch**.
UXP Developer Tools and the exact built manifest were opened for the operator.
The open Premiere project state could not be established, and port 47474 was
already serving a user project, so that server was not queried, stopped, or
replaced. Panel connection/package preview, import, and timeline placement are
therefore not claimed as validated. No Premiere project or media was touched.

## Verification

```bash
npm run premiere:lint
npm run premiere:test
npm run premiere:build
```

Host mocks implement only the official Premiere 25.6 methods listed above.
