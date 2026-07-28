#!/usr/bin/env bash
# retire-next.sh — wave 1 of the Next teardown. Flips nginx's catch-all from
# Next to Phoenix, tears out the write-gate machinery, stops the pm2 process.
# Deletes NO code: Next's tree stays on disk so rollback is nginx + pm2 only.
#
# Run ON THE BOX as root:  sudo bash scripts/deploy/retire-next.sh [--check]
#   --check : read-only. Reports current state and the exact diff it would apply.
#
# Spec: docs/superpowers/specs/2026-07-28-next-teardown-design.md
# Rollback: cp the printed backup over the config, nginx -t && systemctl reload
#           nginx, pm2 start localfinds.
set -euo pipefail

# --source-only lets the selftest source this file for its functions without
# running any phase. Must be handled before anything else executes.
SOURCE_ONLY=0
[ "${1:-}" = "--source-only" ] && SOURCE_ONLY=1

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

NGX="${RETIRE_NEXT_NGX:-/etc/nginx/sites-available/localfinds.me}"
PM2_PROC="${RETIRE_NEXT_PM2_PROC:-localfinds}"
SITE="${RETIRE_NEXT_SITE:-https://localfinds.me}"
TEST_MODE="${RETIRE_NEXT_TEST:-0}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$NGX.bak-next-teardown-$TS"

say()   { printf '%s\n' "$*"; }
phase() { printf '\n=== %s ===\n' "$*"; }
abort() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

# del_block <file> <location-token>
# Deletes one `location <token> { ... }` block. Handles the one-liner form
# (`location @login { return 302 /auth/log-in; }`) separately: a range delete
# from a self-closing line runs on to the NEXT block's closing brace and eats
# a neighbour. Returns 1 (and changes nothing) when the block is absent.
#
# The match is anchored to an actual `location` directive: the line must
# begin (after optional leading whitespace) with the `location` keyword.
# Without this, an unanchored substring search matches the token's text
# inside a comment too (e.g. "# see location /api/runs/ for details" above
# an unrelated block) and del_block deletes the wrong block while reporting
# success. The nginx config this runs against in production is hand-
# maintained and known to carry comments like that above location blocks.
del_block() {
  local file="$1" token="$2" line
  line="$(grep -n -E -- '^[[:space:]]*location[[:space:]]' "$file" \
            | grep -F -- "location $token " | head -1 | cut -d: -f1 || true)"
  [ -n "$line" ] || line="$(grep -n -E -- '^[[:space:]]*location[[:space:]]' "$file" \
            | grep -F -- "location $token{" | head -1 | cut -d: -f1 || true)"
  [ -n "$line" ] || return 1

  if sed -n "${line}p" "$file" | grep -q '}'; then
    sed -i "${line}d" "$file"          # self-closing one-liner
  else
    sed -i "${line},/^[[:space:]]*}/d" "$file"
  fi
}

[ "$SOURCE_ONLY" = 1 ] && return 0 2>/dev/null || true
