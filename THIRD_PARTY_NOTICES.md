# Third-party notices

## Stem Studio

Clipper Cowboy's managed audio-splitting lifecycle and output contract follow
Stem Studio source:
<https://github.com/wassermanproductions/stem-studio> (commit
`fa1bcd092cecca891cb6192d805999165df351e7`).

Copyright © 2026 Sam Wasserman (wassermanproductions.com · wasserman.ai).
Licensed under Apache License 2.0. The original `NOTICE` requires retaining
this credit in derivative works. Clipper Cowboy has changed the integration to
run as an internal managed capability, not as the Stem Studio application or
its MCP server.

Clipper Cowboy vendors adapted copies of upstream
`python/stemstudio_worker/separate.py` and `engine_stub.py` in
`server/audio/stemstudio_worker/`. Its Node pipeline follows upstream's
`mcp/src/setup.ts` (managed venv provisioning) and `mcp/src/pipeline.ts`
(extract → worker → conform → publish). Local modifications and the pinned
source list are in `server/audio/stemstudio_worker/SOURCE_PROVENANCE.md`.

## Audio models and libraries

Stem Studio identifies TIGER-DnR weights as Apache-2.0 and Demucs as MIT.
Its Max tier may use MVSEP-CDX23 weights, whose upstream notice says they are
for personal use. Clipper Cowboy does not bundle, download, or expose either
the upstream Tiger/MVSEP engines or Max tier in this release. See Stem Studio's
`NOTICE` for complete upstream attribution and model links.
