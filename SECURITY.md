# Security Notes for Clipper Cowboy

## What this repo is trying to protect

- **API credentials must never be committed to git.**
  - `.env` is intentionally ignored in `.gitignore`.
  - The app expects keys to be local only (Bring-Your-Own keys).
- **Video content and local sidecars are user-owned and stay local.**
  - Project data is stored under `PROJECT_DIR` and `.clipcataloger/`.
- **Client should not expose secrets.**
  - Frontend only reads `hasOpenAIKey` (boolean).
  - Actual `OPENAI_API_KEY` value is only used server-side.
- **The API is local-only.**
  - It binds to `127.0.0.1`, and browser access is limited to the local UI.
  - Do not expose it through a tunnel, port-forward, or reverse proxy. The API
    intentionally has no remote-user authentication.
  - A headless API auto-started by MCP additionally requires a random
    per-process capability token. Normal interactive UI launches remain
    loopback-only and assume the local user account is trusted.
- **MCP is narrow and path-safe.**
  - The stdio server accepts catalog IDs instead of arbitrary media paths.
  - Returned media paths are canonicalized beneath the active project or
    `clips/`; traversal and symlink escapes are rejected.
  - MCP has no key, settings, shell, delete, reveal, trash, or generic file tool.
  - AI analysis requires explicit confirmation that sampled frames will be
    uploaded to OpenAI.
- **Stem Studio runs as an isolated local integration.**
  - The selected checkout is trusted local code; Clipper verifies package and
    MCP identity but cannot make an untrusted checkout safe.
  - Stem receives only allowlisted process settings plus Clipper-derived input
    and private staging paths. `OPENAI_API_KEY`, `CLIPPER_API_TOKEN`, proxy
    credentials, and `.env` contents are not forwarded.
  - Clipper never invokes Stem Studio's environment installer. Model setup and
    first-use downloads remain explicit Stem Studio operations.
  - Outputs are validated inside `derived/stems/.jobs/` and renamed into place
    only after the producer stops; existing results are never overwritten.
  - Cancellation is cooperative first (`cancel_job`) and then closes the MCP
    bridge. If a modified/broken checkout stops responding, inspect local
    processes because upstream worker teardown cannot be guaranteed.

## For public release preparation

Before sharing with an external collaborator, confirm:

1. `OPENAI_API_KEY` is not present in tracked files.
2. `.env` is absent from tracked files and exists only locally.
3. `npm run build` succeeds.
4. App works without AI key for basic clip/edit/export flows (AI features show as disabled).
5. No debug logs print secret values.
6. `npm run stem:smoke` proves the Stem child does not inherit credential
   sentinels and cannot publish paths outside `derived/stems/`.

## Required key behavior (current implementation)

- AI features (`caption`, `organize`, `character recognition`) **read key from server environment** via `OPENAI_API_KEY`.
- The first-run wizard and Settings screen write key to local `.env` so users can set it on their machine.
- `.env` is written with owner-only permissions and values containing newlines
  are rejected.
- If no key is present, AI endpoints return clear errors and non-AI workflows continue.

## Rotating credentials before sharing publicly

If this repo was ever run with a real key:

- Revoke that key in your provider console.
- Issue a new key and test with the new key locally.
- Never paste real keys into screenshots, PR notes, or issues.
