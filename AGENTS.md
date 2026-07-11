# AGENTS.md — Clipper Cowboy

This file is the operational contract for coding agents working in this repo.

## Safety boundaries

- Never read, print, copy, commit, or transmit `.env`.
- Never put a real key in source, screenshots, issues, logs, or agent messages.
- Keep the server bound to `127.0.0.1`; it has local filesystem capabilities
  and is not a remotely authenticated service.
- Treat `PROJECT_DIR` media and `.clipcataloger/` metadata as user-owned data.
- Do not publish, push, or change repository visibility without explicit owner
  approval.

## Commands

```bash
npm install
npm run typecheck
npm run build
npm run mcp:verify
npm run security:smoke
npm run stem:smoke
npm run doctor
npm run public:ready
npm run dev
```

Definition of done for a shareable change: root typecheck/build, MCP
typecheck/tests/stdio smoke, doctor, and `npm run public:ready` all pass.
The security smoke must also pass; it covers managed API authentication,
malicious sidecar containment, and cross-process export filename races.

## Repository map

- `src/`: React UI.
- `server/`: local Express API and filesystem/media operations.
- `scripts/public-ready-check.sh`: release and secret preflight.
- `mcp/`: standalone stdio agent server; `mcp/README.md` is its user contract.
- `.env.example`: placeholder configuration only.
- `docs/INTEGRATIONS.md`: official Stem Studio MCP handoff.

## Stem Studio handoff

Do not vendor or reimplement Stem Studio. Use its official MCP server. Inputs
must be exported clip IDs/paths derived by Clipper, and outputs must stage and
publish beneath `PROJECT_DIR/derived/stems/`. Never forward the parent
environment: use the fixed allowlist and keep `OPENAI_API_KEY`,
`CLIPPER_API_TOKEN`, proxies, and `.env` out. Never auto-run `setup_environment`
or install/download models. High is the strongest automatic recommendation;
Max is an explicit user choice because its additional model has separate
upstream licensing. Run `npm run stem:smoke` after integration changes. Follow
`docs/INTEGRATIONS.md` for cancellation and restart limitations.

## MCP hard rules

- Stdout is JSON-RPC only. Diagnostics go to stderr and must be redacted.
- Resolve the repository from the built module or explicit `CLIPPER_ROOT`, not
  the caller's working directory.
- Never add arbitrary-path, shell, delete/trash, key, or settings tools.
- Mutation tools accept validated catalog IDs and fixed destinations only.
- Canonicalize returned media with `realpath`; reject traversal and symlink
  escapes.
- OpenAI tools require explicit external-upload confirmation.
- Long exports are serialized and support `wait:false` plus `check_job`.
