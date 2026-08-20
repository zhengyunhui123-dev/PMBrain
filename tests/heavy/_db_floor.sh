#!/usr/bin/env bash
# Shared name floor for heavy scripts that mutate any accepted database URL.
# Source this file before any psql call or CLI that can initialize/mutate DB.

_pmbrain_db_floor_check() {
  _pmbrain_db_floor_url="$1"
  _pmbrain_db_floor_var="$2"
  [ -z "$_pmbrain_db_floor_url" ] && return 0

  _pmbrain_db_floor_prequery="${_pmbrain_db_floor_url%%\?*}"
  _pmbrain_db_floor_name="${_pmbrain_db_floor_prequery##*/}"
  if [ -z "$_pmbrain_db_floor_name" ]; then
    echo "[db-floor] REFUSING: $_pmbrain_db_floor_var has no database name" >&2
    exit 2
  fi
  if ! printf '%s' "$_pmbrain_db_floor_name" | grep -qiE '(^|[_-])test([_-]|$)'; then
    if [ "${GBRAIN_E2E_ALLOW_DB:-}" != "$_pmbrain_db_floor_name" ]; then
      echo "[db-floor] REFUSING: $_pmbrain_db_floor_var database \"$_pmbrain_db_floor_name\" does not look like a test database" >&2
      echo "  Expected \"test\" as a name segment, e.g. gbrain_test." >&2
      echo "  For an intentional one-shot exception: GBRAIN_E2E_ALLOW_DB=$_pmbrain_db_floor_name <command>" >&2
      exit 2
    fi
  fi
}

_pmbrain_db_floor_check "${DATABASE_URL:-}" DATABASE_URL
_pmbrain_db_floor_check "${GBRAIN_DATABASE_URL:-}" GBRAIN_DATABASE_URL
_pmbrain_db_floor_check "${PMBRAIN_DATABASE_URL:-}" PMBRAIN_DATABASE_URL
unset -f _pmbrain_db_floor_check 2>/dev/null || true
unset _pmbrain_db_floor_url _pmbrain_db_floor_var _pmbrain_db_floor_prequery _pmbrain_db_floor_name 2>/dev/null || true
