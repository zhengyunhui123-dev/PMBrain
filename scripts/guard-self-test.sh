#!/usr/bin/env bash
# Verify that self-tested scanner guards fail on known-bad fixtures and pass
# known-good fixtures. The registry also makes new check-* files impossible to
# add without classifying their runtime behavior.

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

MANIFEST="scripts/guards-manifest.tsv"
FIXTURES="test/fixtures/guards"
BUDGET_SECONDS=30
START=$(date +%s)
failures=0
tested=0
SHELL_BIN="${BASH:-bash}"

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: $MANIFEST missing — the guard registry is load-bearing."
  exit 1
fi

run_guard() {
  local guard="$1" fixture_root="$2"
  case "$guard" in
    *.mjs) GBRAIN_GUARD_ROOT="$fixture_root" node "scripts/$guard" "$fixture_root" >/dev/null 2>&1 ;;
    *.ts)  GBRAIN_GUARD_ROOT="$fixture_root" bun run "scripts/$guard" "$fixture_root" >/dev/null 2>&1 ;;
    *)     GBRAIN_GUARD_ROOT="$fixture_root" "$SHELL_BIN" "scripts/$guard" >/dev/null 2>&1 ;;
  esac
}

while IFS=$'\t' read -r guard klass selftest _notes; do
  case "$guard" in ''|'#'*) continue ;; esac
  [ "$selftest" = "yes" ] || continue
  tested=$((tested + 1))

  bad="$FIXTURES/$guard/bad"
  good="$FIXTURES/$guard/good"
  if [ ! -d "$bad" ] || [ ! -d "$good" ]; then
    echo "FAIL  $guard: manifest says selftest=yes but fixtures are missing"
    failures=$((failures + 1))
    continue
  fi

  if run_guard "$guard" "$bad"; then
    echo "FAIL  $guard: known-bad fixture was not rejected"
    failures=$((failures + 1))
  elif ! run_guard "$guard" "$good"; then
    echo "FAIL  $guard: known-good fixture was rejected"
    failures=$((failures + 1))
  else
    echo "ok    $guard (bad→fail, good→pass)"
  fi
done < "$MANIFEST"

# Manifest completeness: every check script must have one registry row.
for f in scripts/check-*.sh scripts/check-*.mjs scripts/check-*.ts; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  if ! grep -q "^${base}[[:space:]]" "$MANIFEST"; then
    echo "FAIL  $base: no row in $MANIFEST — classify it"
    failures=$((failures + 1))
  fi
done

ELAPSED=$(( $(date +%s) - START ))
echo "guard self-test: $tested guard(s) self-tested, ${ELAPSED}s (budget ${BUDGET_SECONDS}s)"
if [ "$ELAPSED" -gt "$BUDGET_SECONDS" ]; then
  echo "FAIL  guard self-test exceeded the ${BUDGET_SECONDS}s runtime budget"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "ERROR: $failures guard self-test failure(s)."
  exit 1
fi
echo "OK: all self-tested guards catch their bad fixtures and pass their good ones"
