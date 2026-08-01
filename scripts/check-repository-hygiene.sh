#!/usr/bin/env bash
# Reject local state, credentials, databases, logs, and build outputs that
# must never be tracked in the PMBrain source repository.

set -euo pipefail

MODE=working
case "${1:-}" in
  "") ;;
  --staged) MODE=staged ;;
  --help|-h)
    echo "usage: scripts/check-repository-hygiene.sh [--staged]"
    exit 1
    ;;
  *)
    echo "check-repository-hygiene: unknown arg: $1" >&2
    exit 2
    ;;
esac

if ! ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "check-repository-hygiene: not inside a git repository" >&2
  exit 2
fi
cd "$ROOT"

if [ "$MODE" = staged ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
else
  FILES=$(git ls-files 2>/dev/null || true)
fi

FOUND=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    .env.*.example|*/.env.*.example)
      continue
      ;;
    .env|*/.env|.env.*|*/.env.*|*.env|.mcp.json|load-env.ps1|_clear_lock.ts|check-lock.mjs|\
    .gbrain/*|.pmbrain/*|context/*|.context/*|.codex/*|.codex-remote-attachments/*|.workbuddy/*|\
    .tmp-pglite-*/*|*.pglite/*|node_modules/*|*/node_modules/*|bin/*|\
    desktop/out/*|desktop/dist/*|desktop/build/extraResources/*|\
    *.log|*.dmg|*.AppImage|*.blockmap)
      echo "[repository-hygiene] forbidden tracked local/generated file: $file" >&2
      FOUND=1
      ;;
  esac
done <<< "$FILES"

if [ "$FOUND" -ne 0 ]; then
  echo "Remove the paths from Git tracking and keep them covered by .gitignore." >&2
  exit 1
fi

exit 0
