#!/usr/bin/env bash
# retire-next.sh — verifies the Next -> Phoenix cutover; it does not perform it.
#
# Four fix rounds on a bash nginx block-extractor each made block extraction
# correct on one more construct and wrong on a new one, the last silently
# deleting three blocks while reporting success. Neil edits nginx by hand, as
# in all five prior cutovers (runbook: scripts/deploy/next-teardown.md); this
# script asserts whole-file invariants and probes the running site — neither
# needs to understand nginx grammar.
# It mutates nothing and deletes no code: Next's tree stays on disk, so
# rollback is nginx + pm2 only.
#
# Run ON THE BOX as the normal deploy user — NEVER root. pm2 keeps per-user
# daemons; under sudo this script would address root's daemon, not ubuntu's,
# and report Next missing while Next kept serving.
#
#   bash scripts/deploy/retire-next.sh --check      # before the hand edit
#   bash scripts/deploy/retire-next.sh --verify     # after nginx -t && reload
#   bash scripts/deploy/retire-next.sh --stop-next  # after --verify passes
#
# Spec: docs/superpowers/specs/2026-07-28-next-teardown-design.md
set -euo pipefail

say()   { printf '%s\n' "$*"; }
phase() { printf '\n=== %s ===\n' "$*"; }
abort() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

usage() {
  printf 'usage: %s --check | --verify | --stop-next | --source-only\n' "${0##*/}" >&2
  exit 1
}

# Mode flags are mutually exclusive; anything else (including no argument,
# two mode flags, or a valid mode followed by a stray argument) is a usage
# error. --source-only lets the selftest source this file for its functions
# without running any phase. --stop-next runs pm2 stop (never delete — the
# process definition is the rollback path for the whole soak) and re-probes.
#
# The argument-count check must come first: a case on "${1:-}" alone only
# ever inspects the first word, so `--check --verify` would match --check
# and silently ignore --verify (and `--check junk` would match --check and
# silently ignore junk) — exactly one argument, no more, or usage.
SOURCE_ONLY=0
CHECK=0
VERIFY=0
STOP_NEXT=0
[ "$#" -eq 1 ] || usage
case "$1" in
  --check)       CHECK=1 ;;
  --verify)      VERIFY=1 ;;
  --stop-next)   STOP_NEXT=1 ;;
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
#
# Comment lines (first non-whitespace character is #) are stripped first. An
# nginx comment mentioning a forbidden token — left behind when an operator
# deletes a block but not the comment sitting above it — must not read as
# that construct still being live; §3's fixture ships exactly such a comment
# above the auth_request target. This is a LINE-level filter applied
# uniformly to every count in this script: it has no notion of where a block
# starts or ends, no brace counting, no quoted-string handling. That
# block-aware approach was tried across four rounds and abandoned (see the
# header comment) precisely because it kept being wrong about one more
# construct. This only asks, per line, "is the first non-whitespace
# character a #" — which nginx's own comment syntax answers unambiguously
# without parsing anything else about the file.
count_of() { grep -v '^[[:space:]]*#' -- "$1" 2>/dev/null | grep -cF -- "$2" || true; }

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

# Fetchers and judges are kept separate so the judges are unit-testable
# without a network: they take already-fetched values (a status code, a
# response body) and only decide pass/fail, so the selftest can source this
# file (--source-only) and call them directly with hand-built good and bad
# inputs. The fetchers are thin curl wrappers that only ever run on the box,
# reached only from inside `[ "$TEST_MODE" != 1 ]` branches below — never
# invoked by the selftest, never touching the network under
# RETIRE_NEXT_TEST=1.

expect_status() {  # expect_status <label> <actual> <expected>
  [ -n "$2" ] || abort "$1: no status returned (connection failed?)"
  [ "$2" != "000" ] || abort "$1: curl could not connect"
  [ "$2" = "$3" ] || abort "$1: got $2, expected $3"
  say "  ok  $1 -> $2"
}

expect_no_next() {  # expect_no_next <label> <body>
  [ -n "$2" ] || abort "$1: empty response body (connection failed?)"
  printf '%s' "$2" | grep -qi '__NEXT_DATA__\|next' \
    && abort "$1: response body still looks like Next — the flip did not take"
  say "  ok  $1 -> no Next markers"
}

# expect_next is --check's mirror of expect_no_next: before the hand edit,
# the catch-all must still fall through to Next, so an unknown path's body
# must contain Next markers. One guard, not a separate empty-body guard plus
# a marker guard: an empty body already contains no markers, so a bolted-on
# `[ -n "$2" ] || abort ...` ahead of the grep would never be the thing that
# actually catches an empty body in practice — the grep already does, making
# the extra guard unreachable dead code dressed up as a second check.
expect_next() {  # expect_next <label> <body>
  printf '%s' "$2" | grep -qi '__NEXT_DATA__\|next' \
    || abort "$1: response body does not look like Next (or was empty — connection failed?) — the catch-all no longer falls through to Next as this runbook assumes; stop before hand-editing nginx"
  say "  ok  $1 -> looks like Next (pre-edit assumption holds)"
}

# expect_no_connection is deliberately the inverse of expect_status's 000
# guard: there, curl's connection-failure code means the probe is broken and
# nothing else it saw can be trusted. Here, "nothing answered" IS the claim
# under test — the only way to confirm Next itself (not nginx, not pm2, not
# the catch-all) is not serving on its own port. Mechanism-independent: it
# doesn't care whether pm2 reports stopped, deleted, crashed, or
# never-started — only whether anything answered within the timeout. curl's
# 000 covers both "nothing is listening" and "something is listening but
# never responded" (a hung or wedged process) — either way, nothing capable
# of actually serving a request answered on 127.0.0.1:3001.
expect_no_connection() {  # expect_no_connection <label> <status>
  [ -n "$2" ] || abort "$1: no status returned"
  [ "$2" = "000" ] || abort "$1: answered with status $2 — it is still serving"
  say "  ok  $1 -> no connection (not serving)"
}

http_status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$SITE$1"; }
body_of()     { curl -sS --max-time 10 "$SITE$1"; }
# 2>/dev/null here only: on the expected happy path (Next stopped) this curl
# fails to connect, and -sS prints "curl: (7) Failed to connect ..." to
# stderr right before the script's own "ok ... no connection" line — noise
# that reads as an error during a cutover watched live. The pass/fail
# decision is expect_no_connection's, driven entirely by the captured status
# code (including curl's own 000 on failure), never by this stderr text, so
# suppressing it costs no information the check relies on.
next_status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:3001/" 2>/dev/null; }

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

    # Every assertion above is a whole-file count; none of them can tell
    # whether the catch-all's OWN proxy_pass is what an unknown path is
    # actually served by. This confirms the runbook's premise — unknown
    # paths fall through to Next — before the operator trusts it enough to
    # hand-edit nginx. If this doesn't hold, the assumption behind the whole
    # cutover is wrong and nothing below should proceed.
    expect_next "catch-all (pre-edit)" "$(body_of /__teardown_probe__)"
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
  if [ "$TEST_MODE" = 1 ]; then
    say "test mode: skipping live probes"
  else
    expect_status "/"              "$(http_status /)"              200
    expect_status "/feed"          "$(http_status /feed)"          200
    expect_status "/places"        "$(http_status /places)"        200
    expect_status "/sources"       "$(http_status /sources)"       200
    expect_status "/auth/log-in"   "$(http_status /auth/log-in)"   200
    # Steward-gated by live_session :steward's on_mount, so a redirect is correct.
    expect_status "/agents (gated)" "$(http_status /agents)"       302

    # Every status probe above hits a path with its own nginx location, so
    # none of them can tell whether the CATCH-ALL's own proxy_pass reaches
    # Phoenix — a deleted proxy_pass, a typo'd port, or a bare `return 404;`
    # on the catch-all all look identical to those probes. /robots.txt has
    # no location of its own; it is served only by Plug.Static mounted
    # `at: "/"` in phoenix/lib/localfinds_web/endpoint.ex, restricted to
    # LocalfindsWeb.static_paths() (phoenix/lib/localfinds_web.ex), which
    # lists it, and the file exists at phoenix/priv/static/robots.txt. So it
    # can only 200 if the catch-all's proxy_pass actually reaches Phoenix —
    # nginx's own 404 (no proxy_pass, or `return 404;`) and 502 (a dead
    # upstream) both fail this, where they'd pass a body-only check. This is
    # the one POSITIVE assertion in this phase; everything else here proves
    # absence, which a catch-all reaching nothing also satisfies.
    expect_status "/robots.txt (via the catch-all)" "$(http_status /robots.txt)" 200

    # Status cannot discriminate — both backends 404 an unknown path. The body can.
    expect_no_next "catch-all" "$(body_of /__teardown_probe__)"

    # App-code gating survived the removal of nginx's write gate.
    expect_status "token-less POST /feed/settings" \
      "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$SITE/feed/settings")" 403

    # A shell client cannot complete a LiveView handshake; this bounds the claim
    # to "nginx routes it to a socket handler at all".
    ws="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
          -H 'Connection: Upgrade' -H 'Upgrade: websocket' "$SITE/live/websocket")"
    case "$ws" in
      404|502) abort "/live/websocket returned $ws — the socket is not routed" ;;
      *) say "  ok  /live/websocket -> $ws (not 404/502)" ;;
    esac
  fi
  exit 0
fi

if [ "$STOP_NEXT" = 1 ]; then
  phase "stop next"
  if [ "$TEST_MODE" = 1 ]; then
    say "test mode: skipping pm2"
  else
    if pm2 describe "$PM2_PROC" >/dev/null 2>&1; then
      pm2 stop "$PM2_PROC"
      say "stopped pm2 $PM2_PROC (NOT deleted — the definition is the rollback path)"
    else
      say "already done (no pm2 $PM2_PROC)"
    fi

    expect_status "/ after pm2 stop" "$(http_status /)" 200
    expect_status "/robots.txt after pm2 stop (via the catch-all)" \
      "$(http_status /robots.txt)" 200
    expect_no_next "catch-all after pm2 stop" "$(body_of /__teardown_probe__)"

    # The three probes above go through nginx and Phoenix; none of them can
    # tell whether Next itself is still listening on :3001 — a catch-all
    # pointed at Phoenix looks identical either way. This asks Next
    # directly, bypassing nginx and pm2 both, so it holds regardless of what
    # either one reports. It runs every time this branch runs, not only when
    # this invocation had something to stop, so re-running --stop-next later
    # (the T+1 gate in next-teardown.md §9) re-establishes the fact rather
    # than assuming it still holds from whenever pm2 was actually stopped.
    expect_no_connection "Next backend (127.0.0.1:3001)" "$(next_status)"
  fi
  exit 0
fi
