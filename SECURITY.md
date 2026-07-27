# Security Notes for Clipper Cowboy

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, discussion,
social post, or shared reproduction containing private media or credentials.
Use GitHub's private vulnerability reporting form:

<https://github.com/princezoho/clipper-cowboy/security/advisories/new>

Include the affected commit/version, operating system, reproduction steps,
impact, and the smallest safe proof of concept. Remove API keys, personal paths,
private footage, and project metadata. Maintainers may investigate and respond
when available, but this community project makes no response-time, remediation,
embargo, bounty, support, or disclosure-timeline guarantee.

## Supported versions and threat model

Security fixes target the latest commit on the default branch. Older commits,
forks, modified builds, third-party packages, and unofficial binaries are not
supported.

Clipper Cowboy is designed for one trusted local user on a trusted machine. Its
HTTP API must remain bound to loopback. Internet-facing, multi-user, shared-host,
container-service, tunnelled, proxied, or otherwise remotely exposed deployments
are outside the security model.

## What this repo is trying to protect

- **API credentials must never be committed to git.**
  - `.env` is intentionally ignored in `.gitignore`.
  - The app expects keys to be local only (Bring-Your-Own keys).
- **Video content and local sidecars are user-owned and stay local.**
  - Project data is stored under `PROJECT_DIR` and `.clipcataloger/`.
  - Project media may be intentionally moved or renamed; those operations use
    no-overwrite destinations and are recorded in Roundup after success.
  - Roundup inventory and stems handoff only read source media. Roundup Export
    Copy creates a verified, uniquely named output under `derived/roundup/`;
    it does not overwrite, trash, or remove the source.
  - Future destructive Roundup actions require explicit user confirmation.
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
- **Audio splitting uses an explicitly configured local integration.**
  - Universal Clipper accepts only a validated official Stem Studio MCP entry;
    selecting a checkout still means trusting local code that runs with the
    current user's filesystem permissions.
  - The child receives only an allowlisted environment. `OPENAI_API_KEY`,
    `CLIPPER_API_TOKEN`, proxy credentials, and `.env` contents are not
    forwarded.
  - Clipper does not install Stem Studio dependencies, invoke
    `setup_environment`, or download models.
  - Outputs are validated in unique contained destinations before publication;
    existing results are never silently overwritten.
  - Stem job status is observable when Clipper is attached to its UI server.
    Clipper does not expose a cancellation operation there: it cannot safely
    guarantee lifecycle ownership of an independently running server. A future
    cancellation capability must only be added when that ownership is safe.

## User responsibility and limitation of liability

Users must keep backups, protect configured credentials, review file-operation
previews, assess third-party code and model licenses, and test the software in
their own environment. Passing this repository's checks is not a security audit,
certification, warranty, or guarantee that every vulnerability or data-loss
condition has been found.

The project is provided under the MIT License without warranty and with the
license's limitation of liability. See [DISCLAIMER.md](./DISCLAIMER.md) for the
plain-language risk, responsibility, third-party, and compatibility notice.

## For public release preparation

Before sharing with an external collaborator, confirm:

1. `OPENAI_API_KEY` is not present in tracked files.
2. `.env` is absent from tracked files and exists only locally.
3. `npm run build` succeeds.
4. App works without AI key for basic clip/edit/export flows (AI features show as disabled).
5. No debug logs print secret values.
6. `npm run stem:smoke` proves the official MCP child receives only the fixed
   environment allowlist, rejects non-JSON stdout and escaped/mismatched
   outputs, and cannot publish outside unique `derived/stems/` jobs.

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
