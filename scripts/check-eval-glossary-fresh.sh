#!/usr/bin/env bash
# v0.32.3 — CI guard for docs/eval/METRIC_GLOSSARY.md freshness.
#
# Mirrors the scripts/check-jsonb-pattern.sh / check-progress-to-stdout.sh
# discipline: regenerate the doc into a tmp file, diff against the committed
# version, fail the build if they drift.
#
# Run: bash scripts/check-eval-glossary-fresh.sh
# CI wires this through `bun run test` so PRs that bump the glossary module
# without regenerating the doc are caught before review.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
exec bun run scripts/check-eval-glossary-fresh.ts
