#!/usr/bin/env bash
# CI guard: fail if any non-serial unit test file violates intra-process
# isolation rules. The v0.26.4 parallel runner loads multiple test files
# into one bun process per shard; module-level state (env vars, PGLite
# engines, mock.module overrides) leaks across files in that process and
# silently flakes other tests.
#
# Rules enforced (non-serial unit test files only):
#  R1: no `process.env.X = ...`, `process.env['X'] = ...`,
#      `delete process.env.X`, `Object.assign(process.env, ...)`,
#      `Reflect.set(process.env, ...)` mutations. Use withEnv() helper or
#      rename the file to `*.serial.test.ts`.
#  R2: no `mock.module(...)` anywhere. Top-level module mocks affect every
#      other file in the same shard process. Rename to `*.serial.test.ts`.
#  R3: `new PGLiteEngine(` may only appear within ~50 lines following a
#      `beforeAll(` line. Engines created at module scope (or in describe
#      bodies) leak across files in the shard process.
#  R4: any file that creates `new PGLiteEngine(` must call `.disconnect(`
#      inside an `afterAll(` block. Without disconnect, engines leak across
#      file boundaries within a shard process.
#
# Scope:
#  - Recursively scans `test/**/*.test.ts`.
#  - Skips `*.serial.test.ts` entirely (the quarantine escape hatch).
#  - Skips `test/e2e/**` (E2E runs sequentially in its own runner; not in
#    the parallel pool).
#
# Allow-list:
#  Files in `scripts/check-test-isolation.allowlist` (one filename per
#  line, # comments allowed) are skipped. This exists because v0.26.7
#  ships the lint as a foundation; v0.26.8 (env sweep) and v0.26.9
#  (PGLite sweep) remove entries as files get fixed. New files MUST NOT
#  be added — the allow-list shrinks over time, never grows.
#
# Usage: scripts/check-test-isolation.sh [TARGET_DIR]
# Exit:  0 when clean, 1 when un-allow-listed violations found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

TARGET_DIR="${1:-test}"
ALLOWLIST_FILE="$ROOT/scripts/check-test-isolation.allowlist"

# Read allowlist (one filename per line, # comments allowed). Empty file
# is fine — every violation will fail. Cached into ALLOWLIST so the
# per-file check (~700 lookups per run) is one pure-bash `case` match.
ALLOWLIST=""
if [ -f "$ALLOWLIST_FILE" ]; then
  ALLOWLIST="$(grep -v '^[[:space:]]*#' "$ALLOWLIST_FILE" | grep -v '^[[:space:]]*$' || true)"
fi

is_allowlisted() {
  local f="$1"
  if [ -z "$ALLOWLIST" ]; then
    return 1
  fi
  # Use a pure-bash `case` whole-line match against the newline-delimited
  # allowlist instead of `echo | grep -qxF`. v0.41.8 CI flake (verify job
  # 77771356276): the grep pipe form occasionally failed to match the
  # first allowlist entry on Ubuntu 24.04 + bash 5 under
  # `bun run` + GNU `timeout` (couldn't reproduce on macOS bash 3.2 with
  # the same allowlist file content + lint script content + checkout
  # state). Pure-bash case is locale-free, pipe-free, subshell-free,
  # set-e-quirk-free, and ~100x faster on every call.
  case $'\n'"$ALLOWLIST"$'\n' in
    *$'\n'"$f"$'\n'*) return 0 ;;
  esac
  return 1
}

# Find non-serial unit test files (excluding test/e2e). Portable across
# bash 3.2 (macOS default) and bash 4+; no mapfile.
FILE_LIST="$(find "$TARGET_DIR" -name '*.test.ts' \
  -not -name '*.serial.test.ts' \
  -not -path "*/e2e/*" \
  -type f 2>/dev/null | sort)"

violations=0
file_count=0

while IFS= read -r f; do
  [ -z "$f" ] && continue
  file_count=$((file_count + 1))
done <<EOF
$FILE_LIST
EOF

emit_violation() {
  local f="$1" rule="$2" detail="$3" lines="$4"
  if is_allowlisted "$f"; then
    return
  fi
  echo "ERROR: $f"
  echo "       rule $rule: $detail"
  if [ -n "$lines" ]; then
    echo "$lines" | head -3 | sed 's/^/         /'
  fi
  violations=$((violations + 1))
}

# Audit all files in one (or a few xargs-sized) awk processes. This preserves
# the original four rules while avoiding hundreds of per-file grep/awk
# process launches on Windows Git Bash.
VIOLATIONS=$(
  find "$TARGET_DIR" -name '*.test.ts' \
    -not -name '*.serial.test.ts' \
    -not -path "*/e2e/*" \
    -type f -print0 2>/dev/null |
    xargs -0 awk '
      function finish() {
        if (!seen) return
        if (r1) print "R1\t" file "\t" r1_detail
        if (r2) print "R2\t" file "\t" r2_detail
        if (r3) print "R3\t" file "\t" r3_detail
        if (pglite && (!after_all || !disconnect)) print "R4\t" file "\tcreates PGLiteEngine but missing afterAll/disconnect"
      }
      FNR == 1 {
        if (seen) finish()
        seen = 1
        file = FILENAME
        r1 = 0
        r2 = 0
        r3 = 0
        pglite = 0
        after_all = 0
        disconnect = 0
        last_before_all = -1000
      }
      /process[.]env[.][A-Za-z_][A-Za-z_0-9]*[[:space:]]*=[^=]/ ||
      /process[.]env\[[^]]+\][[:space:]]*=[^=]/ ||
      /delete[[:space:]]+process[.]env([.]|\[)/ ||
      /Object[.]assign[[:space:]]*\([[:space:]]*process[.]env/ ||
      /Reflect[.]set[[:space:]]*\([[:space:]]*process[.]env/ {
        if (!r1) { r1 = 1; r1_detail = FNR ":" $0 }
      }
      /mock[.]module[[:space:]]*\(/ {
        if (!r2) { r2 = 1; r2_detail = FNR ":" $0 }
      }
      /beforeAll[[:space:]]*\(/ { last_before_all = FNR }
      /new[[:space:]]+PGLiteEngine[[:space:]]*\(/ {
        pglite = 1
        if (!r3 && FNR - last_before_all > 50) { r3 = 1; r3_detail = FNR ":" $0 }
      }
      /afterAll[[:space:]]*\(/ { after_all = 1 }
      /[.]disconnect[[:space:]]*\(/ { disconnect = 1 }
      END { finish() }
    ' 2>/dev/null || true
)

while IFS=$'\t' read -r rule file detail; do
  [ -z "$file" ] && continue
  if is_allowlisted "$file"; then
    continue
  fi
  case "$rule" in
    R1) emit_violation "$file" "$rule" "process.env mutation; use withEnv() or rename to *.serial.test.ts" "$detail" ;;
    R2) emit_violation "$file" "$rule" "mock.module() leaks across files in the shard process; rename to *.serial.test.ts" "$detail" ;;
    R3) emit_violation "$file" "$rule" "new PGLiteEngine(...) outside beforeAll() context (>50 lines); move into beforeAll" "$detail" ;;
    R4) emit_violation "$file" "$rule" "creates PGLiteEngine but missing afterAll(() => engine.disconnect()); engine leaks across files in the shard process" "$detail" ;;
  esac
done <<EOF
$VIOLATIONS
EOF

if [ $violations -gt 0 ]; then
  echo
  echo "check-test-isolation: FAIL ($violations violation(s))"
  echo
  echo "Fix:"
  echo "  - For env mutations, use withEnv() from test/helpers/with-env.ts"
  echo "  - For mock.module(), rename to *.serial.test.ts (quarantine)"
  echo "  - For PGLiteEngine, follow the canonical pattern in"
  echo "    test/helpers/reset-pglite.ts JSDoc and CLAUDE.md."
  echo
  echo "Or, if this is a baseline file from before the lint shipped,"
  echo "add it to scripts/check-test-isolation.allowlist (with a TODO"
  echo "comment naming the sweep PR that will remove it)."
  exit 1
fi

echo "check-test-isolation: OK ($file_count non-serial unit files scanned)"
