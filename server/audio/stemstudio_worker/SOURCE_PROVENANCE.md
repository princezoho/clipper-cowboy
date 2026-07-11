# Stem Studio source provenance

- Upstream: https://github.com/wassermanproductions/stem-studio
- Pinned revision: `fa1bcd092cecca891cb6192d805999165df351e7`
- License: Apache-2.0; upstream `NOTICE` attribution is reproduced in
  `THIRD_PARTY_NOTICES.md`.

## Imported and adapted files

- `python/stemstudio_worker/separate.py` — retained its JSON-lines job protocol,
  input/output contract, progress events, and source separation entrypoint.
- `python/stemstudio_worker/engine_stub.py` — retained its frequency-band
  dialogue/music/effects separation and mixture-residual output behavior.

## Local modifications

The worker is packaged under Clipper Cowboy's server source, accepts only
fixed internal arguments, and currently exposes only Stem Studio's deterministic
`stub` engine with `fast` quality. Upstream Tiger and MVSEP engines, their
vendored model code, and their download/licensing requirements are not imported
or exposed. This avoids representing model-dependent quality modes as available.
