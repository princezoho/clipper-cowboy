# Public release checklist

Before creating a public release:

1. Run `npm run verify` and `npm run public:ready`.
2. Review tracked files and history for credentials; never publish `.env`.
3. Audit screenshots and examples for private media, paths, keys, names, and
   customer content.
4. Check README, MCP, integration, security, contributing, and support links.
5. Confirm repository description, topics, license, and social preview in
   GitHub metadata.
6. Confirm the intended default branch and branch protections in GitHub.
7. Create an annotated release tag and GitHub release with concise notes.
8. Confirm a rollback plan: retain the prior tag, document a revert commit, and
   avoid destructive release or visibility changes without maintainer review.

Publishing a repository or changing its visibility is a maintainer action, not
part of this checklist's automated commands.
