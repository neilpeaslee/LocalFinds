#!/usr/bin/env bash
# retire-next.sh — verifies the Next -> Phoenix cutover; it does not perform it.
#
# Four fix rounds on a bash nginx block-extractor each made block extraction
# correct on one more construct and wrong on a new one, the last silently
# deleting three blocks while reporting success. Neil edits nginx by hand, as
# in all five prior cutovers (runbook: scripts/deploy/next-teardown.md); this
# script only asserts whole-file invariants and (once the live probe suite
# lands) probes the running site — neither needs to understand nginx grammar.
# It mutates nothing and deletes no code: Next's tree stays on disk, so
# rollback is nginx + pm2 only.
#
# Run ON THE BOX as the normal deploy user — NEVER root. pm2 keeps per-user
# daemons; under sudo this script would address root's daemon, not ubuntu's,
# and report Next missing while Next kept serving.
#
#   bash scripts/deploy/retire-next.sh --check    # before the hand edit
#   bash scripts/deploy/retire-next.sh --verify   # after nginx -t && reload
#
# Spec: docs/superpowers/specs/2026-07-28-next-teardown-design.md
set -euo pipefail

say()   { printf '%s\n' "$*"; }
phase() { printf '\n=== %s ===\n' "$*"; }
abort() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

usage() {
  printf 'usage: %s --check | --verify | --source-only\n' "${0##*/}" >&2
  exit 1
}

# Mode flags are mutually exclusive; anything else (including no argument,
# two mode flags, or a valid mode followed by a stray argument) is a usage
# error. --source-only lets the selftest source this file for its functions
# without running any phase. --stop-next is a future addition (pm2 stop +
# re-probe) — not implemented yet.
#
# The argument-count check must come first: a case on "${1:-}" alone only
# ever inspects the first word, so `--check --verify` would match --check
# and silently ignore --verify (and `--check junk` would match --check and
# silently ignore junk) — exactly one argument, no more, or usage.
SOURCE_ONLY=0
CHECK=0
VERIFY=0
[ "$#" -eq 1 ] || usage
case "$1" in
  --check)       CHECK=1 ;;
  --verify)      VERIFY=1 ;;
  --source-only) SOURCE_ONLY=1 ;;
  *)             usage ;;
esac

NGX="${RETIRE_NEXT_NGX:-/etc/nginx/sites-available/localfinds.me}"
PM2_PROC="${RETIRE_NEXT_PM2_PROC:-localfinds}"
SITE="${RETIRE_NEXT_SITE:-https://localfinds.me}"
TEST_MODE="${RETIRE_NEXT_TEST:-0}"

# count_of <file> <fixed-string> -> prints an integer, never fails. Plain
# `grep -c` exits 1 on zero matches, which would kill the script under
# set -e the first time an invariant is legitimately satisfied by absence.
count_of() { grep -cF -- "$2" "$1" 2>/dev/null || true; }

expect_count() {  # expect_count <label> <actual> <expected>
  [ "$2" = "$3" ] || abort "$1: found $2, expected $3"
  say "  ok  $1 = $2"
}

expect_absent() {  # expect_absent <file> <label> <fixed-string>
  n="$(count_of "$1" "$3")"
  [ "$n" = 0 ] || abort "$2: still present ($n occurrence(s) of '$3')"
  say "  ok  $2 absent"
}

expect_present_count() {  # expect_present_count <file> <label> <fixed-string>
  n="$(count_of "$1" "$3")"
  [ "$n" -ge 1 ] || abort "$2: missing ('$3' not found)"
  say "  ok  $2 present"
}

[ "$SOURCE_ONLY" = 1 ] && return 0 2>/dev/null || true

# pm2 keeps per-user daemons. Under sudo we would address root's daemon, not
# ubuntu's — reporting "no such process" while Next keeps serving. Nothing
# here needs root any more, so refuse it outright.
#
# Deliberately NOT gated behind TEST_MODE: this is the one guard where a
# silent no-op under test is unacceptable (a re-inversion of this exact
# check — the mistake it exists to prevent — would still show a green
# selftest if `id` were never actually consulted). The selftest controls it
# through PATH instead, with a stubbed `id`.
[ "$(id -u)" -ne 0 ] || \
  abort "do not run this as root — pm2 is per-user, and sudo would target root's daemon"
[ -r "$NGX" ] || abort "cannot read $NGX (try: sudo chmod o+r $NGX, or read it with sudo and re-run)"

inventory() {
  grep -nE '^[[:space:]]*(location|proxy_pass|auth_request|error_page)' "$1" \
    || say "(nothing matched — wrong file?)"
}

# Neither mode below asks where a brace closes: every assertion is a
# whole-file count. The one property counts cannot establish — that the
# catch-all's OWN proxy_pass moved, rather than some other block's, since
# 127.0.0.1:3001/4000 also appear (or appeared) in blocks being torn down —
# is left to the live probe instead. That is strictly better evidence: it
# tests what nginx actually does with the config, not what a parser believes
# the file says.

if [ "$CHECK" = 1 ]; then
  phase "P0 preflight"
  say "nginx config : $NGX"
  say "pm2 process  : $PM2_PROC"
  say "site         : $SITE"
  say ""
  say "--- current routing ---"
  inventory "$NGX"
  say "--- end ---"

  phase "check: nginx config"
  expect_present_count "$NGX" "the Next backend"        "127.0.0.1:3001"
  expect_present_count "$NGX" "auth_request"             "auth_request"
  expect_present_count "$NGX" "the write gate"           "@write_gate"
  expect_present_count "$NGX" "the login redirect"       "@login"
  expect_present_count "$NGX" "the 418 method split"     "418"
  expect_present_count "$NGX" "the auth_request target"  "location = /auth/check"
  expect_present_count "$NGX" "the SSE route"            "location /api/runs/"

  expect_count "the catch-all still exists" "$(count_of "$NGX" "location / {")" 1

  for loc in "location /live" "location /assets" "location /auth/" "location = / {" \
             "location = /feed" "location ^~ /feed/" "location = /places" \
             "location ^~ /places/" "location = /sources" "location ^~ /sources/" \
             "location = /agents" "location ^~ /agents/"; do
    expect_present_count "$NGX" "$loc" "$loc"
  done

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
      || say "WARNING: pm2 $PM2_PROC not found — Next may already be stopped"
  fi

  say ""
  say "--check: read-only, nothing changed. Hand-edit nginx per"
  say "scripts/deploy/next-teardown.md, then re-run with --verify."
  exit 0
fi

if [ "$VERIFY" = 1 ]; then
  phase "verify: nginx config"
  expect_absent "$NGX" "the Next backend"        "127.0.0.1:3001"
  expect_absent "$NGX" "auth_request"            "auth_request"
  expect_absent "$NGX" "the write gate"          "@write_gate"
  expect_absent "$NGX" "the login redirect"      "@login"
  expect_absent "$NGX" "the 418 method split"    "418"
  expect_absent "$NGX" "the auth_request target" "location = /auth/check"
  expect_absent "$NGX" "the SSE route"           "location /api/runs/"
  expect_absent "$NGX" "the Next asset route"    "location /_next/"

  expect_count "the catch-all still exists" "$(count_of "$NGX" "location / {")" 1

  for loc in "location /live" "location /assets" "location /auth/" "location = / {" \
             "location = /feed" "location ^~ /feed/" "location = /places" \
             "location ^~ /places/" "location = /sources" "location ^~ /sources/" \
             "location = /agents" "location ^~ /agents/"; do
    expect_present_count "$NGX" "$loc" "$loc"
  done

  phase "verify: live"
  # ...probe suite from Task 4 lands here...
  exit 0
fi
