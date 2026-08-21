#!/usr/bin/env bash
# v0.41.18.0 — CI guard against double-retry hazard.
#
# Engine batch methods (addLinksBatch / addTimelineEntriesBatch /
# upsertChunks) self-retry via withRetry(BULK_RETRY_OPTS) inside the engine
# implementation. Wrapping them ALSO at the call site produces 3×3=9 retry
# attempts under failure, amplifying load on a recovering circuit breaker
# and worsening the very incident the wave was designed to fix.
#
# This script greps src/ for the pattern and fails the build if found.
# Catches the migration-ordering hazard from the v0.41.18.0 eng review (D6)
# AND prevents future refactors from re-introducing the bug class.
#
# Usage: scripts/check-no-double-retry.sh
# Exit:  0 when no matches, 1 when matches found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
SCAN_ROOT="${GBRAIN_GUARD_ROOT:-src}"
if [ -x /usr/bin/find ]; then
  FIND_BIN=/usr/bin/find
else
  FIND_BIN=find
fi

# Match: withRetry(...) wrapping any of the 3 engine batch methods.
# The greedy `.*` between `withRetry(` and `engine.` covers both the
# arrow-fn form and any direct invocation. (gbrain-allow-direct-insert: doc comment)
# Multi-line wraps are caught by `grep -E` per file (line-wise) for the
# common single-line case; multi-line wraps still get caught by a separate
# multi-line pass below.
PATTERN='withRetry\(.*engine\.(addLinksBatch|addTimelineEntriesBatch|upsertChunks)'

# Single-line scan (covers ~95% of real cases).
if grep -rEn "$PATTERN" "$SCAN_ROOT" --include='*.ts' 2>/dev/null; then
  echo
  echo "ERROR: Found withRetry(...engine.{addLinksBatch|addTimelineEntriesBatch|upsertChunks})"
  echo "       pattern in src/."
  echo
  echo "       Engine batch methods self-retry via withRetry(BULK_RETRY_OPTS) in"
  echo "       postgres-engine.ts + pglite-engine.ts. Wrapping AGAIN at the call site"
  echo "       produces 3×3=9 retry attempts under failure, amplifying load on a"
  echo "       recovering circuit breaker."
  echo
  echo "       Fix: delete the outer withRetry wrap. Pass auditSite as a kwarg:"
  echo "         await engine.addLinks(batch, { auditSite: 'extract.links_inc' }); // example"
  echo
  echo "       Audit JSONL records the retries silently at "
  echo "       ~/.gbrain/audit/batch-retry-YYYY-Www.jsonl; check"
  echo "       \`gbrain doctor\` for the batch_retry_health surface."
  exit 1
fi

# Multi-line scan: a withRetry( on one line and the engine call on the next
# few. Bounded to a four-line window so we don't flag distant unrelated calls.
# Use a portable awk pass consistently; pcregrep is not present on many
# Windows Git Bash installations and must not control whether this guard runs.
if ! command -v awk >/dev/null 2>&1; then
  echo "ERROR: awk is unavailable for multiline retry guard" >&2
  exit 1
fi
if "$FIND_BIN" "$SCAN_ROOT" -type f -name '*.ts' -print0 | xargs -0 awk '
  FNR == 1 { pending=0 }
  /withRetry[[:space:]]*\(/ { pending=4 }
  pending > 0 && /engine\.(addLinksBatch|addTimelineEntriesBatch|upsertChunks)/ {
    print FILENAME ":" FNR ": multiline withRetry(...engine.batch...) wrap found"
    found=1
  }
  pending > 0 { pending-- }
  END { exit found ? 0 : 1 }
' 2>/dev/null; then
  echo
  echo "ERROR: Multi-line withRetry(...engine.batch...) wrap found in $SCAN_ROOT. See above."
  exit 1
fi

echo "OK: no withRetry(...engine.batch...) double-retry patterns in $SCAN_ROOT/"
