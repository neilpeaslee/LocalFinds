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

# block_end_line <file> <start-line>
# Prints the line number where the `{ ... }` opened by <start-line> closes,
# tracking brace depth per line rather than looking for the first line that
# merely LOOKS like a closing brace. A block that contains its own nested
# brace — e.g. a multi-line `if ($request_method !~ ^(GET|HEAD)$) { ... }`
# guard inside a location block, written with the `}` alone on its own
# line — would fool a "first ^[[:space:]]*} after the start" search into
# stopping at the INNER brace, truncating the block. Depth tracking handles
# any nesting and any formatting. A one-liner block (its own `{` and `}` on
# the <start-line> itself, e.g. `location @login { return 302 ...; }`)
# naturally returns <start-line> unchanged, since depth reaches zero before
# the line is done.
block_end_line() {
  local file="$1" start="$2"
  awk -v s="$start" '
    NR < s { next }
    {
      depth += gsub(/{/, "{")
      depth -= gsub(/}/, "}")
      if (depth <= 0) { print NR; exit }
    }
  ' "$file"
}

# del_block <file> <location-token>
# Deletes one `location <token> { ... }` block, from its start line through
# its depth-matched closing brace (see block_end_line above — this is what
# makes a one-liner block and a block with nested multi-line braces both
# come out right without separate cases). Returns 1 (and changes nothing)
# when the block is absent.
#
# The match is anchored to an actual `location` directive: the line must
# begin (after optional leading whitespace) with the `location` keyword.
# Without this, an unanchored substring search matches the token's text
# inside a comment too (e.g. "# see location /api/runs/ for details" above
# an unrelated block) and del_block deletes the wrong block while reporting
# success. The nginx config this runs against in production is hand-
# maintained and known to carry comments like that above location blocks.
del_block() {
  local file="$1" token="$2" line end
  line="$(grep -n -E -- '^[[:space:]]*location[[:space:]]' "$file" \
            | grep -F -- "location $token " | head -1 | cut -d: -f1 || true)"
  [ -n "$line" ] || line="$(grep -n -E -- '^[[:space:]]*location[[:space:]]' "$file" \
            | grep -F -- "location $token{" | head -1 | cut -d: -f1 || true)"
  [ -n "$line" ] || return 1

  end="$(block_end_line "$file" "$line")"
  sed -i "${line},${end}d" "$file"
}

[ "$SOURCE_ONLY" = 1 ] && return 0 2>/dev/null || true

[ "$TEST_MODE" = 1 ] || [ "$(id -u)" -eq 0 ] || abort "must run as root"
[ -f "$NGX" ] || abort "no nginx config at $NGX"

expect_present() {  # expect_present <file> <label> <fixed-string>
  grep -qF -- "$3" "$1" || abort "$2 not found in $1 — this box does not match the spec; stop and re-read the config"
}

inventory() {
  grep -nE '^[[:space:]]*(location|proxy_pass|auth_request|error_page)' "$1" \
    || say "(nothing matched — wrong file?)"
}

phase "P0 preflight"
say "nginx config : $NGX"
say "pm2 process  : $PM2_PROC"
say "site         : $SITE"
say ""
say "--- current routing ---"
inventory "$NGX"
say "--- end ---"

expect_present "$NGX" "the Next catch-all (location / {)" "location / {"
expect_present "$NGX" "the write gate (@write_gate)" "@write_gate"
expect_present "$NGX" "a Next backend (127.0.0.1:3001)" "127.0.0.1:3001"

# expect_present only proves a string exists SOMEWHERE in the file. That is
# satisfied for 127.0.0.1:3001 by @write_gate and /api/runs/ even when the
# catch-all itself proxy_passes elsewhere, and satisfied for "location / {"
# by the first of several catch-alls even when there's more than one (a
# second server{} for the HTTP->HTTPS redirect can legitimately carry its
# own bare `location /`, and del_block's head -1 would silently act on
# whichever one comes first). Check the relationship, not just presence:
# locate the catch-all's own block and look inside it, after confirming
# there is exactly one to look at.
catch_all_lines="$(grep -n -E -- '^[[:space:]]*location[[:space:]]' "$NGX" \
                      | grep -F -- 'location / {' | cut -d: -f1 || true)"
catch_all_count=0
[ -z "$catch_all_lines" ] || catch_all_count="$(printf '%s\n' "$catch_all_lines" | grep -c .)"

check_single_catch_all() {
  [ "$catch_all_count" -le 1 ] \
    || abort "found $catch_all_count catch-all blocks (location / {) in $NGX — this script assumes a single catch-all; stop and disambiguate by hand"
}

check_catch_all_backend() {
  [ "$catch_all_count" = 1 ] || return 0
  local start end body found
  start="$catch_all_lines"
  end="$(block_end_line "$NGX" "$start")"
  body="$(sed -n "${start},${end}p" "$NGX")"
  printf '%s\n' "$body" | grep -qF -- "proxy_pass http://127.0.0.1:3001;" && return 0
  found="$(printf '%s\n' "$body" | grep -m1 -oE 'proxy_pass http://[^;]+;' || true)"
  abort "the catch-all (location / {) does not proxy_pass to 127.0.0.1:3001 — found: ${found:-no proxy_pass in the block} — this box does not match the spec; stop and re-read the config"
}

check_single_catch_all
check_catch_all_backend

if grep -qF "location /_next/" "$NGX"; then
  say "note: /_next/ HAS its own block — it will be deleted"
else
  say "note: /_next/ has no block — it falls through the catch-all; nothing to delete"
fi

if [ "$TEST_MODE" != 1 ]; then
  curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:4000/ \
    || abort "Phoenix is not answering on :4000 — do not flip anything"
  say "phoenix on :4000: OK"
  pm2 describe "$PM2_PROC" >/dev/null 2>&1 \
    && say "pm2 $PM2_PROC: present" \
    || say "WARNING: pm2 $PM2_PROC not found — P3 will skip"
fi

if [ "$CHECK" = 1 ]; then
  say ""
  say "--check: read-only, nothing changed. Re-run without --check to apply."
  exit 0
fi
