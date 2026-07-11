# Stem Studio source provenance

- Upstream: https://github.com/wassermanproductions/stem-studio
- Pinned revision: `fa1bcd092cecca891cb6192d805999165df351e7`
- License: Apache-2.0; upstream `NOTICE` attribution is reproduced in
  `THIRD_PARTY_NOTICES.md`.

## Imported and adapted files

- `python/stemstudio_worker/separate.py` — retained its JSON-lines job protocol,
  input/output contract, progress events, and source separation entrypoint.
- `python/stemstudio_worker/engine_mvsep.py` — adapted its real Demucs
  `apply_model` loading/inference pattern and three-stem mapping.

## Local modifications

The worker is packaged under Clipper Cowboy's server source and accepts only
fixed internal arguments. Production exposes only `demucs` with the pinned
`demucs==4.0.1` package and official `htdemucs` (Fast) and `htdemucs_ft`
(High) checkpoints. Fast downloads only after explicit setup; High downloads
only after the user explicitly selects it, into Clipper's managed cache. The old
frequency-band `engine_stub.py` remains only as unreferenced historical source;
the production CLI rejects `--engine stub`.

TIGER and MVSEP-CDX23 are not exposed. This avoids their additional vendored
model-code and licensing boundaries while retaining a real model-based engine.
