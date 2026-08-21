#!/usr/bin/env bash
# CI gate: admin React app must compile.
#
# Catches missing-symbol bugs (e.g., calling loadApiKeys() when only
# loadAgents is defined) before they reach E2E. Codex flagged this gap
# during the PR #586 review pass — five Claude review passes missed
# the loadApiKeys reference because the bash test pipeline doesn't run
# Vite builds. This script runs `bun install` in admin/ to ensure
# react/vite/etc. are present, then runs the canonical repository build. That
# build also regenerates tracked embedded/release artifacts; a build that
# rewrites the pre-existing generated files is a failure because they were
# stale.
#
# Skip with GBRAIN_SKIP_ADMIN_BUILD=1 (e.g., for fast inner-loop test
# runs that don't touch admin/src). Production CI must NOT skip.
set -euo pipefail

if [ "${GBRAIN_SKIP_ADMIN_BUILD:-0}" = "1" ]; then
  echo "[check:admin-build] GBRAIN_SKIP_ADMIN_BUILD=1, skipping"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d admin ]; then
  echo "[check:admin-build] no admin/ directory, skipping"
  exit 0
fi

cd admin

# Frozen install — the Admin build gate must not rewrite its lockfile while
# checking generated artifacts.
bun install --frozen-lockfile --silent

# A developer may have already refreshed generated files in the working tree,
# so comparing to HEAD here would reject a valid uncommitted change. Snapshot
# the generated inputs and fail only when the canonical build rewrites them.
# The CI workflows additionally compare the post-build tree to Git HEAD.
SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pmbrain-admin-build.XXXXXX")"
trap 'rm -rf "$SNAPSHOT_DIR"' EXIT
snapshot_generated() {
  local label="$1" path="$2"
  if [ -d "$path" ]; then
    cp -R "$path" "$SNAPSHOT_DIR/$label"
  elif [ -f "$path" ]; then
    cp "$path" "$SNAPSHOT_DIR/$label"
  else
    touch "$SNAPSHOT_DIR/$label.missing"
  fi
}
snapshot_generated admin-dist "$ROOT/admin/dist"
snapshot_generated admin-embedded "$ROOT/src/admin-embedded.ts"
snapshot_generated release-manifest "$ROOT/release-manifest.json"

# Build runs `tsc -b && vite build`, then normalizes and embeds the output.
# Exit non-zero on TS error, missing symbol, Vite bundling error, or stale
# generated output.
cd "$ROOT"
bun run build:admin

compare_generated() {
  local label="$1" path="$2" snapshot="$SNAPSHOT_DIR/$label"
  if [ -f "$SNAPSHOT_DIR/$label.missing" ]; then
    [ ! -e "$path" ]
    return
  fi
  if [ -d "$snapshot" ]; then
    [ -d "$path" ] && diff -qr "$snapshot" "$path" >/dev/null
  else
    [ -f "$path" ] && cmp -s "$snapshot" "$path"
  fi
}

for generated in \
  'admin-dist|admin/dist' \
  'admin-embedded|src/admin-embedded.ts' \
  'release-manifest|release-manifest.json'; do
  label="${generated%%|*}"
  path="$ROOT/${generated#*|}"
  if ! compare_generated "$label" "$path"; then
    echo "[check:admin-build] canonical build rewrote $path." >&2
    echo "[check:admin-build] generated artifacts were stale; run bun run build:admin and commit the resulting tracked files." >&2
    exit 1
  fi
done

echo "[check:admin-build] admin build and generated artifacts are current"
