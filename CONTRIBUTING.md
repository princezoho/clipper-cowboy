# Contributing to Clipper Cowboy

Glad you're here. PRs, issues, and discussions are all welcome.

## Dev setup

```bash
git clone https://github.com/princezoho/clipper-cowboy.git
cd clipper-cowboy
npm run setup
npm run dev
```

That boots two processes via `concurrently`:

- **Vite UI** on <http://localhost:5173> with HMR.
- **Express API** on <http://localhost:47474> via `tsx watch` (auto-reloads
  on TS changes).

Open `:5173` for the app. The Vite dev server proxies `/api/*` to `:47474`.

On a brand-new clone you'll land on the first-run onboarding screen — point
it at any folder (it'll be created if missing) and you're off.

## Pre-share / pre-publish checks

Before sharing this repository with anyone outside your machine:

1. Run:

   ```bash
   npm run public:ready
   ```

   This validates there are no obvious credential leaks, ensures docs exist,
   and confirms the UI build, MCP typecheck/tests/protocol smoke, and local
   dependency doctor all succeed.
2. Confirm `SECURITY.md` is up to date and that you agree the checklist matches
   your repo state.
3. Audit `.env` usage locally:

   - `OPENAI_API_KEY` should be set only in your local `.env`.
   - never commit test keys or pasted secrets in issues/PRs/screenshots.
4. Refresh README screenshots if UI changed materially since last screenshot update.
5. Keep the repo private until you are ready to publish.

> This is a local-first app with BYO AI keys. The repo must remain functional
> when `OPENAI_API_KEY` is not set.

## Project layout

- `server/` — Express + ffmpeg. Each route file under `server/routes/` is
  mounted on `/api`. Server-side path resolution and `.env` parsing lives in
  `server/config.ts`.
- `src/` — Vite + React + Tailwind. Top-level views in `src/views/`, shared
  React components in `src/components/`, the API client + hooks in
  `src/lib/`.
- `mcp/` — standalone stdio server for agent-driven catalog and export work.
  Keep its tools ID-based and run `npm run mcp:verify` after every change.
- `public/mockups/` — living UX design docs. The `ux-preview.html` page is
  hand-written HTML/Tailwind that mirrors what the real React app looks like.
  Treat it as a spec, not a build artifact.
- `scripts/` — local dev helpers (rebundle, restart, etc.).

The exporter (`server/smartcut.ts`) is the heart of the app and is
deliberately small. Read it before changing how clips get written to disk —
the bit-identical-body guarantee is load-bearing.

## Code style

- **TypeScript strict mode.** Run `npm run typecheck` and
  `npm run mcp:typecheck` before opening a PR.
- **No code-formatter wars.** The repo doesn't pin Prettier or ESLint; just
  match the surrounding style (2-space indent, single quotes in JSX, double
  quotes in TS).
- **React:** function components only, hooks for everything. No class
  components.
- **Server:** keep route handlers thin. Push real work into `server/util/` or
  domain modules.
- **Comments explain *why*, not *what*.** Skip narration comments. Call out
  trade-offs, non-obvious invariants, and gotchas.

## Things that would be especially welcome

- Better cross-platform support (Linux/Windows polish, "Reveal in Explorer",
  etc.).
- Additional source codecs in `smartcut.ts` (VP9, AV1).
- Tests for the keyframe boundary cases in `smartcut.ts`.
- Accessibility passes on the editor view.

## Things that need a discussion first

- Anything that changes the on-disk sidecar layout
  (`<project>/.clipcataloger/`). Renaming or restructuring that folder
  breaks every existing install.
- Switching away from local-first storage. The app's whole pitch is "your
  footage never leaves your machine."

## Questions

Open an issue, or start a discussion. Code questions in PRs, design
questions in issues.

Thanks for helping make Clipper Cowboy better.
