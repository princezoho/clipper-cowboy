#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: scripts/configure-github-repo.sh [owner/repo]"
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

gh auth status >/dev/null

repo="${1:-}"
if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi

description="Local-first AI video clip triage, cataloging, smart-cut export, and MCP automation."
topics=(
  video-editing
  ffmpeg
  ai-video
  openai
  react
  express
  mcp
  local-first
  clip-cataloging
  stem-separation
)

args=(repo edit "$repo" --description "$description")
for topic in "${topics[@]}"; do
  args+=(--add-topic "$topic")
done

gh "${args[@]}"

echo "Updated description and topics for $repo."
echo "Manual, high-impact steps remain: review the default branch, repository visibility,"
echo "homepage, social preview, branch protections, and release/tag settings in GitHub."
