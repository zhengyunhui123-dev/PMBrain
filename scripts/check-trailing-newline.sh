#!/usr/bin/env bash
# CI guard: every text file under src/, test/, and the repo root .yml/.md
# files must end with a newline. POSIX-noncompliant trailing data shows up
# as a phantom diff on every future edit and trips most linters.
#
# Sibling to scripts/check-progress-to-stdout.sh and
# scripts/check-jsonb-pattern.sh per CLAUDE.md's CI guard pattern.
# Wired into `bun run test` via package.json's `test` script.

set -euo pipefail

cd "$(dirname "$0")/.."
bun scripts/check-trailing-newline.ts
