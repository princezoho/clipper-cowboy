#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clipper-public-ready.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

printf "\nClipper Cowboy Public-Readiness Check\n"
printf "Repo: %s\n\n" "$ROOT_DIR"

printf "1) Ensure .env is not tracked...\n"
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "   ERROR: .env is tracked. Remove it before sharing."
  exit 1
else
  echo "   OK: .env is untracked/ignored."
fi

printf "2) Search publishable files for obvious secrets...\n"
SECRET_PATTERN="(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|bearer[[:space:]]+[A-Za-z0-9._-]{20,})"
git ls-files --cached --others --exclude-standard -z | while IFS= read -r -d '' file; do
  [ "$file" = "package-lock.json" ] && continue
  if grep -IlE "$SECRET_PATTERN" -- "$file" >/dev/null 2>&1; then
    printf '%s\n' "$file"
  fi
done >"$TMP_DIR/secret-hit-files.txt"
if [ -s "$TMP_DIR/secret-hit-files.txt" ]; then
  echo "   ERROR: Potential secret-like strings detected in publishable files."
  echo "   Review these files locally (values are intentionally not printed):"
  sed 's/^/   - /' "$TMP_DIR/secret-hit-files.txt"
  exit 1
else
  echo "   OK: No obvious key-like strings found in publishable files."
fi

printf "2a) Search git history for obvious secret shapes...\n"
git log --all -G "$SECRET_PATTERN" --name-only --pretty=format: \
  | sed '/^$/d' | sort -u >"$TMP_DIR/history-secret-hit-files.txt"
if [ -s "$TMP_DIR/history-secret-hit-files.txt" ]; then
  echo "   ERROR: Potential secret-like strings exist in git history."
  echo "   Rotate the credential, then clean history before publishing."
  echo "   Review these historical file paths (values are not printed):"
  sed 's/^/   - /' "$TMP_DIR/history-secret-hit-files.txt"
  exit 1
else
  echo "   OK: No obvious key-like strings found in git history."
fi

printf "2b) Reject tracked local environment files...\n"
tracked_env_files=$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '(^|/)\.env\.example$' || true)
if [ -n "$tracked_env_files" ]; then
  echo "   ERROR: Local environment file(s) are tracked:"
  printf '%s\n' "$tracked_env_files" | sed 's/^/   - /'
  exit 1
else
  echo "   OK: Only the placeholder .env.example may be tracked."
fi

printf "3) Build check...\n"
if npm run build >"$TMP_DIR/build.log" 2>&1; then
  echo "   OK: npm run build passed."
else
  echo "   ERROR: npm run build failed."
  echo "--- build log ---"
  cat "$TMP_DIR/build.log"
  exit 1
fi

printf "3b) MCP type, test, protocol, and media smoke checks...\n"
if npm run mcp:verify >"$TMP_DIR/mcp-verify.log" 2>&1; then
  echo "   OK: MCP typecheck, unit tests, build, stdio smoke, and real media export passed."
else
  echo "   ERROR: MCP verification failed."
  cat "$TMP_DIR/mcp-verify.log"
  exit 1
fi

printf "3c) Local dependency doctor...\n"
if npm run doctor >"$TMP_DIR/doctor.log" 2>&1; then
  echo "   OK: UI, MCP, ffmpeg, and ffprobe prerequisites are ready."
else
  echo "   ERROR: Local readiness doctor failed."
  cat "$TMP_DIR/doctor.log"
  exit 1
fi

printf "3d) Capability and sidecar containment smoke...\n"
if npm run security:smoke >"$TMP_DIR/security-smoke.log" 2>&1; then
  echo "   OK: Managed API auth and destructive path containment passed."
else
  echo "   ERROR: Security smoke failed."
  cat "$TMP_DIR/security-smoke.log"
  exit 1
fi

printf "3e) Managed background audio smoke...\n"
if npm run audio:smoke >"$TMP_DIR/stem-smoke.log" 2>&1; then
  echo "   OK: asynchronous export, credential isolation, and atomic stem publication passed."
else
  echo "   ERROR: managed background audio smoke failed."
  cat "$TMP_DIR/stem-smoke.log"
  exit 1
fi

printf "4) Validate required docs exist...\n"
for f in README.md SECURITY.md THIRD_PARTY_NOTICES.md AGENTS.md mcp/README.md .env.example .github/CODEOWNERS; do
   if [ -f "$f" ]; then
     echo "   OK: $f exists"
   else
     echo "   ERROR: $f missing"
     exit 1
   fi
done

printf "4b) Confirm the server is loopback-only...\n"
if grep -q 'host: "127.0.0.1"' server/config.ts; then
  echo "   OK: API defaults to the local machine only."
else
  echo "   ERROR: Server does not have an explicit loopback-only host."
  exit 1
fi

printf "5) Confirm local-safe defaults documentation is explicit...\n"
if grep -q "Security-first defaults" README.md && grep -q "Security Notes" SECURITY.md; then
  echo "   OK: Security docs include safety-first framing."
else
  echo "   ERROR: Security framing appears incomplete."
  exit 1
fi

printf "\nAll checks passed. Repo is in a shareable private/public-prep state.\n"
