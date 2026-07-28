#!/usr/bin/env bash
# Exercises retire-next.sh against fixture nginx configs. No box, no root, no
# nginx. Every external command the script calls is stubbed on PATH.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/retire-next.sh"
FAIL=0

pass() { printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAIL=1; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi; }

# A scratch dir with stub nginx/systemctl/pm2/curl ahead of the real ones.
STUBS="$(mktemp -d)"
trap 'rm -rf "$STUBS"' EXIT
for cmd in nginx systemctl pm2; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$STUBS/$cmd"
  chmod +x "$STUBS/$cmd"
done

# `id -u` must report a normal (non-root) uid for every case in this suite
# except the one that deliberately tests the root refusal, which lays its
# own root-returning `id` ahead of this one on PATH for that single
# invocation only. Stubbed rather than left to the real uid so this suite
# behaves the same whether or not it happens to run as root itself (some CI
# sandboxes do).
printf '#!/usr/bin/env bash\necho 1000\n' > "$STUBS/id"
chmod +x "$STUBS/id"

export PATH="$STUBS:$PATH"

work() {  # work <fixture-basename> -> prints a temp copy's path
  local dst; dst="$(mktemp)"
  cp "$HERE/fixtures/$1" "$dst"
  printf '%s\n' "$dst"
}

echo "== mode flags =="

# No arguments and an unrecognised flag are both usage errors, not a silent
# default. Both exit before touching NGX or the network, so no fixture or
# RETIRE_NEXT_NGX override is needed here — set RETIRE_NEXT_TEST=1 anyway to
# keep every invocation in this suite consistent.
out="$(RETIRE_NEXT_TEST=1 bash "$SCRIPT" 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "no arguments exits non-zero" || fail "no arguments exited 0"
out="$(RETIRE_NEXT_TEST=1 bash "$SCRIPT" --bogus 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "an unrecognised flag exits non-zero" || fail "an unrecognised flag exited 0"

# A case statement on "${1:-}" alone only ever inspects the first word, so
# two mode flags (in either order) or a valid mode plus a stray argument
# would silently run the first mode and ignore the rest. All three must be
# usage errors, not a quiet pick-the-first-one.
#
# Each points RETIRE_NEXT_NGX at a valid, readable fixture — unlike the two
# cases above, $1 here IS a recognised mode flag, so if the arg-count guard
# were ever missing the script would run straight through to a normal exit
# 0 against a healthy config. Without a real fixture these would still exit
# non-zero if the guard were broken, but only because the default NGX path
# (/etc/nginx/...) doesn't exist on a dev box — masking the very thing being
# tested. Confirmed by deliberately breaking the guard below.
f="$(work nginx-with-next.conf)"
out="$(RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check --verify 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check --verify (two modes) exits non-zero" \
               || fail "--check --verify exited 0"
# This one points at the AFTER fixture, not the WITH-next fixture used
# above: if the guard were missing, "$1" ("--verify") is what would run,
# and --verify only exits 0 against a post-edit config. Using the wrong
# fixture here would make this case exit non-zero for an unrelated reason
# (content mismatch) even with the guard gone, masking the thing under
# test the same way a missing RETIRE_NEXT_NGX did above.
f="$(work nginx-after-teardown.conf)"
out="$(RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --verify --check 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--verify --check (two modes, reversed) exits non-zero" \
               || fail "--verify --check exited 0"
f="$(work nginx-with-next.conf)"
out="$(RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check junk 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "a valid mode followed by a junk argument exits non-zero" \
               || fail "--check junk exited 0"

# --stop-next joins the same dispatch and must be exercised the same way: two
# mode flags (both orders) and a valid mode plus a stray argument are all
# usage errors, never a quiet pick-the-first-one. As above, each points
# RETIRE_NEXT_NGX at a real, readable fixture (nginx-with-next.conf, the
# pre-edit config): if the arg-count guard were missing, "$1" is what would
# run. For "--stop-next --check" that is --stop-next, which under
# RETIRE_NEXT_TEST=1 skips pm2 and exits 0 cleanly, needing no fixture
# content at all beyond a readable file. For "--check --stop-next" that is
# --check, which exits 0 on this exact fixture (proven in the preflight
# section above). Either way, a healthy fixture is what lets a missing guard
# slip through undetected — the same masking the comment above the two-mode
# --check/--verify cases describes.
f="$(work nginx-with-next.conf)"
out="$(RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --stop-next --check 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--stop-next --check (two modes) exits non-zero" \
               || fail "--stop-next --check exited 0"
f="$(work nginx-with-next.conf)"
out="$(RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check --stop-next 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check --stop-next (two modes, reversed) exits non-zero" \
               || fail "--check --stop-next exited 0"
f="$(work nginx-with-next.conf)"
out="$(RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --stop-next junk 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--stop-next followed by a junk argument exits non-zero" \
               || fail "--stop-next junk exited 0"

echo "== root refusal =="

# pm2 keeps per-user daemons, so this script must never run as root — see
# the comment above the check in retire-next.sh. That guard is deliberately
# NOT bypassed by RETIRE_NEXT_TEST (a re-inversion of it, exactly the
# mistake it exists to prevent, must not still show SELFTEST PASS), so it
# has to be exercised through PATH instead: a root-uid `id` stub laid down
# in its own directory, prepended ahead of $STUBS (whose `id` reports 1000)
# for this one invocation only.
ROOT_STUBS="$(mktemp -d)"
printf '#!/usr/bin/env bash\necho 0\n' > "$ROOT_STUBS/id"
chmod +x "$ROOT_STUBS/id"

f="$(work nginx-with-next.conf)"
out="$(PATH="$ROOT_STUBS:$PATH" RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "refuses to run as root" || fail "ran as root without aborting"
# Matches the abort message's own wording, not a bare 'pm2' substring: the
# P0 preflight phase always prints "pm2 process : ..." on ANY --check run,
# root or not, so a loose `grep -qi pm2` would still say "ok" even if the
# guard were silently gone — exactly the false confidence this case exists
# to rule out.
printf '%s' "$out" | grep -qF 'do not run this as root — pm2 is per-user' \
  && pass "the root refusal names pm2 as the reason" \
  || fail "the root refusal did not mention pm2 as the reason"

rm -rf "$ROOT_STUBS"

echo "== preflight / --check =="

f="$(work nginx-with-next.conf)"
before="$(md5sum < "$f")"
out="$(RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check 2>&1)" && rc=0 || rc=$?
check "--check exits 0 on a healthy config" "$rc" "0"
check "--check changed nothing" "$(md5sum < "$f")" "$before"
check "--check reports the catch-all" \
  "$(printf '%s' "$out" | grep -c 'location / {')" "1"

# A config already missing the catch-all must abort, not proceed.
f="$(work nginx-with-next.conf)"
sed -i '/^    location \/ {$/,/^    }$/d' "$f"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check aborts when the catch-all is missing" \
                || fail "--check accepted a config with no catch-all"

# A config already missing @write_gate must abort, not proceed. @write_gate
# appears TWICE in the fixture (its own block and the catch-all's
# `error_page 418 = @write_gate;`), so both must be stripped or the
# whole-file check still finds "@write_gate" and never aborts.
f="$(work nginx-with-next.conf)"
sed -i '/^    location @write_gate {$/,/^    }$/d' "$f"
sed -i '/@write_gate/d' "$f"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check aborts when @write_gate is missing" \
                || fail "--check accepted a config with no @write_gate"

# A config where the Next backend is already gone (simulating a box where the
# flip already happened) must abort, not proceed.
f="$(work nginx-with-next.conf)"
sed -i 's/127\.0\.0\.1:3001/127.0.0.1:4000/g' "$f"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check aborts when the Next backend (127.0.0.1:3001) is missing" \
                || fail "--check accepted a config with no Next backend"

# More than one `location / {`. Realistic, not hypothetical: the production
# site file may well carry a second `server { listen 80; ... }` for the
# HTTP->HTTPS redirect, which can legitimately contain its own bare
# `location /`. A whole-file count of "location / {" catches this exactly
# the way it catches zero.
f="$(work nginx-with-next.conf)"
cat >> "$f" <<'EOF'

server {
    listen 80;
    server_name localfinds.me;
    location / {
        return 301 https://$host$request_uri;
    }
}
EOF
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check aborts when there is more than one catch-all" \
                || fail "--check accepted a config with two catch-alls"

echo "== --verify =="

# Passes on the expected post-edit config.
f="$(work nginx-after-teardown.conf)"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --verify >/dev/null 2>&1 && rc=0 || rc=$?
check "--verify accepts the after-fixture" "$rc" "0"
check "--verify changed nothing" "$(md5sum < "$f")" "$(md5sum < "$HERE/fixtures/nginx-after-teardown.conf")"

# Fails on both pre-edit configs — this is the whole point.
for fixture in nginx-with-next.conf nginx-with-next-and-_next.conf; do
  f="$(work "$fixture")"
  RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --verify >/dev/null 2>&1 && rc=0 || rc=$?
  [ "$rc" != 0 ] && pass "--verify rejects $fixture" || fail "--verify ACCEPTED $fixture"
done

# And --check is the mirror image: it must reject an already-torn-down config.
f="$(work nginx-after-teardown.conf)"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check rejects the after-fixture" || fail "--check ACCEPTED the after-fixture"

echo "== --verify: each invariant is load-bearing =="

# Reintroduce one forbidden construct at a time; --verify must reject each.
# Each row is chosen to trip EXACTLY ONE expect_absent assertion — the
# original write-gate row ("error_page 418 = @write_gate;") tripped BOTH
# "the write gate" (@write_gate) and "the 418 method split" (418) at once,
# so deleting either assertion alone left the other one still catching the
# row and the test proved nothing about which guard was doing the work. It
# is split below into a block-only row and a 418-only row. A row for
# "location = /auth/check" is added too: no row exercised that assertion at
# all before this fix, so deleting it would have broken zero cases, not one.
while read -r label line; do
  f="$(work nginx-after-teardown.conf)"
  printf '%s\n' "$line" >> "$f"
  RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --verify >/dev/null 2>&1 && rc=0 || rc=$?
  [ "$rc" != 0 ] && pass "--verify catches reintroduced $label" \
                 || fail "--verify MISSED reintroduced $label"
done <<'ROWS'
next-backend        proxy_pass http://127.0.0.1:3001;
auth_request        auth_request /auth/check;
write-gate          location @write_gate { proxy_pass http://127.0.0.1:4000; }
method-split-418    if ($request_method !~ ^(GET|HEAD)$) { return 418; }
login-redirect      location @login { return 302 /auth/log-in; }
auth-check-target   location = /auth/check { proxy_pass http://127.0.0.1:4000; }
runs-sse            location /api/runs/ { proxy_pass http://127.0.0.1:4000; }
next-assets         location /_next/ { proxy_pass http://127.0.0.1:4000; }
ROWS

# A second catch-all reintroduced into an otherwise-correct config must also
# fail. This is the one --verify invariant (expect_count == 1, not a fixed
# string) the reintroduction loop above cannot exercise and the removal loop
# below cannot exercise either (it only removes) — so it needs its own case,
# or "the catch-all still exists" would have no isolating test at all.
f="$(work nginx-after-teardown.conf)"
cat >> "$f" <<'EOF'

server {
    listen 80;
    server_name localfinds.me;
    location / {
        return 301 https://$host$request_uri;
    }
}
EOF
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --verify >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--verify catches a second catch-all" \
               || fail "--verify MISSED a second catch-all"

# Removing a Phoenix location must also fail — the invariants cut both ways.
# All twelve locations are exercised, not a sample: each expect_present_count
# needs its own isolating case the same way each expect_absent above does.
for loc in "location /live {" "location /assets {" "location /auth/ {" \
           "location = / {" "location = /feed {" "location ^~ /feed/ {" \
           "location = /places {" "location ^~ /places/ {" \
           "location = /sources {" "location ^~ /sources/ {" \
           "location = /agents {" "location ^~ /agents/ {"; do
  f="$(work nginx-after-teardown.conf)"
  grep -vF "$loc" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --verify >/dev/null 2>&1 && rc=0 || rc=$?
  [ "$rc" != 0 ] && pass "--verify catches a missing '$loc'" \
                 || fail "--verify MISSED a missing '$loc'"
done

echo "== --stop-next =="

# --stop-next must never touch pm2 or the network under RETIRE_NEXT_TEST=1
# (the same rule --check/--verify's live probes already follow). A stub pm2
# that silently no-ops — like the generic `exit 0` stubs in $STUBS — cannot
# prove that: "pm2 describe" failing quietly and falling through to the
# "already done" branch prints different words but still exits 0, so an
# output-only check could pass even with the TEST_MODE guard gone. A pm2
# stub that leaves a marker file if invoked AT ALL, checked for absence,
# proves pm2 was never called rather than inferring it from silence.
PM2_MARKER="$(mktemp -u)"
MARKER_STUBS="$(mktemp -d)"
cat > "$MARKER_STUBS/pm2" <<EOF
#!/usr/bin/env bash
touch "$PM2_MARKER"
exit 0
EOF
chmod +x "$MARKER_STUBS/pm2"

f="$(work nginx-with-next.conf)"
before="$(md5sum < "$f")"
out="$(PATH="$MARKER_STUBS:$PATH" RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --stop-next 2>&1)" && rc=0 || rc=$?
check "--stop-next alone exits 0" "$rc" "0"
check "--stop-next changed nothing" "$(md5sum < "$f")" "$before"
[ -e "$PM2_MARKER" ] \
  && fail "--stop-next invoked pm2 under RETIRE_NEXT_TEST=1" \
  || pass "--stop-next never invoked pm2 under RETIRE_NEXT_TEST=1"
printf '%s' "$out" | grep -qF 'test mode: skipping pm2' \
  && pass "--stop-next reports test mode: skipping pm2" \
  || fail "--stop-next did not report skipping pm2"

rm -f "$PM2_MARKER"
rm -rf "$MARKER_STUBS"

echo "== probe judges =="

( . "$SCRIPT" --source-only; expect_status "x" "200" "200" ) >/dev/null 2>&1 \
  && pass "expect_status accepts a match" || fail "expect_status rejected a match"
( . "$SCRIPT" --source-only; expect_status "x" "404" "200" ) >/dev/null 2>&1 \
  && fail "expect_status accepted a mismatch" || pass "expect_status rejects a mismatch"
( . "$SCRIPT" --source-only; expect_status "x" "" "200" ) >/dev/null 2>&1 \
  && fail "expect_status accepted an empty status" || pass "expect_status rejects an empty status"
( . "$SCRIPT" --source-only; expect_status "x" "000" "200" ) >/dev/null 2>&1 \
  && fail "expect_status accepted curl's connection-failure 000" \
  || pass "expect_status rejects curl's 000"

# The two cases above both compare against expected="200", so the final
# mismatch guard (`[ "$2" = "$3" ]`) would independently catch "" and "000"
# too — they'd still abort even with the empty-status guard or the 000 guard
# deleted, proving nothing about those two guards specifically. These two use
# a matching expected value instead, so the mismatch guard can't fire and
# only the guard under test can be what catches them.
( . "$SCRIPT" --source-only; expect_status "x" "" "" ) >/dev/null 2>&1 \
  && fail "expect_status accepted an empty status matching an empty expected" \
  || pass "expect_status rejects an empty status even against an empty expected"
( . "$SCRIPT" --source-only; expect_status "x" "000" "000" ) >/dev/null 2>&1 \
  && fail "expect_status accepted 000 matching an expected 000" \
  || pass "expect_status rejects 000 even against an expected 000"

( . "$SCRIPT" --source-only; expect_no_next "x" "<h1>Not Found</h1>" ) >/dev/null 2>&1 \
  && pass "expect_no_next accepts a Phoenix body" || fail "expect_no_next rejected a Phoenix body"
( . "$SCRIPT" --source-only; expect_no_next "x" '<script id="__NEXT_DATA__">' ) >/dev/null 2>&1 \
  && fail "expect_no_next accepted __NEXT_DATA__" || pass "expect_no_next rejects __NEXT_DATA__"
( . "$SCRIPT" --source-only; expect_no_next "x" 'powered by Next.js' ) >/dev/null 2>&1 \
  && fail "expect_no_next accepted the word next" || pass "expect_no_next rejects the word next"
( . "$SCRIPT" --source-only; expect_no_next "x" "" ) >/dev/null 2>&1 \
  && fail "expect_no_next accepted an empty body" || pass "expect_no_next rejects an empty body"

# expect_next is --check's mirror of expect_no_next: before the edit, the
# catch-all must still look like Next, so an unknown path's body must
# contain Next markers.
( . "$SCRIPT" --source-only; expect_next "x" '<script id="__NEXT_DATA__">' ) >/dev/null 2>&1 \
  && pass "expect_next accepts a Next body" || fail "expect_next rejected a Next body"
( . "$SCRIPT" --source-only; expect_next "x" "<h1>Not Found</h1>" ) >/dev/null 2>&1 \
  && fail "expect_next accepted a body with no Next markers" \
  || pass "expect_next rejects a body with no Next markers"
( . "$SCRIPT" --source-only; expect_next "x" "" ) >/dev/null 2>&1 \
  && fail "expect_next accepted an empty body" || pass "expect_next rejects an empty body"

[ "$FAIL" = 0 ] && echo "SELFTEST PASS" || echo "SELFTEST FAIL"
exit "$FAIL"
