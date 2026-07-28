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

echo "== --check: each pre-edit invariant is load-bearing =="

# The five cases above only isolate 127.0.0.1:3001, @write_gate, and the
# catch-all count — the mutation report found the other five scalar
# assertions (auth_request, @login, 418, "location = /auth/check",
# "location /api/runs/") plus the entire 12-location presence loop could all
# be deleted from --check with zero selftest failures: the one broad
# negative case above (missing-catch-all etc.) each aborts on the FIRST
# assertion it trips and never proves anything about the ones after it.
# Task 3 gave --verify's invariants this same one-case-per-assertion
# treatment (be24403); this mirrors it for --check. Each row below removes
# EXACTLY the text one assertion requires from an otherwise-healthy
# pre-edit fixture, leaving every assertion that runs before it in file
# order still satisfied, so an abort can only be attributed to the
# assertion under test.

# auth_request: appears twice, inside @write_gate's block and inside
# /api/runs/'s block (`auth_request /auth/check;`), plus once more in the
# comment above the auth_request target — which no longer counts after the
# I1 fix, but is stripped here anyway since it is not what this case is
# isolating. Removing only these lines leaves "@write_gate", "@login",
# "418", "location = /auth/check" and "location /api/runs/" as literal
# strings untouched.
f="$(work nginx-with-next.conf)"
sed -i '/auth_request/d' "$f"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check catches a missing auth_request" \
               || fail "--check MISSED a missing auth_request"

# @login: a single, self-contained line; removing it touches nothing else.
f="$(work nginx-with-next.conf)"
sed -i '/location @login {/d' "$f"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check catches a missing @login" \
               || fail "--check MISSED a missing @login"

# 418: appears on two lines inside the catch-all (`error_page 418 =
# @write_gate;` and `return 418;`). Removing them drops one of @write_gate's
# two occurrences, but its own `location @write_gate {` block still supplies
# one — @write_gate stays present.
f="$(work nginx-with-next.conf)"
sed -i '/error_page 418/d; /return 418;/d' "$f"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check catches a missing 418 method split" \
               || fail "--check MISSED a missing 418 method split"

# location = /auth/check: delete the whole block (its declaration line is
# the string this assertion looks for). The block's own `auth_request
# /auth/check;` line is not an "auth_request" DIRECTIVE call — this is the
# target, not a caller — so the other two "auth_request" occurrences
# (@write_gate, /api/runs/) are untouched and that assertion still passes.
f="$(work nginx-with-next.conf)"
sed -i '/^    location = \/auth\/check {$/,/^    }$/d' "$f"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check catches a missing location = /auth/check" \
               || fail "--check MISSED a missing location = /auth/check"

# location /api/runs/: delete the whole block. It contains one of the two
# "auth_request" occurrences, but @write_gate's block supplies the other, so
# that assertion is untouched.
f="$(work nginx-with-next.conf)"
sed -i '/^    location \/api\/runs\/ {$/,/^    }$/d' "$f"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check catches a missing location /api/runs/" \
               || fail "--check MISSED a missing location /api/runs/"

# The 12-location presence loop: exercise all twelve entries individually,
# not a sample — the same treatment --verify's mirror loop already gets
# below. nginx-with-next.conf (the pre-edit fixture) carries all twelve.
for loc in "location /live {" "location /assets {" "location /auth/ {" \
           "location = / {" "location = /feed {" "location ^~ /feed/ {" \
           "location = /places {" "location ^~ /places/ {" \
           "location = /sources {" "location ^~ /sources/ {" \
           "location = /agents {" "location ^~ /agents/ {"; do
  f="$(work nginx-with-next.conf)"
  grep -vF "$loc" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
  [ "$rc" != 0 ] && pass "--check catches a missing '$loc'" \
                 || fail "--check MISSED a missing '$loc'"
done

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

echo "== --verify: leftover comments do not abort a correct cutover =="

# nginx-with-next.conf carries a comment directly above the auth_request
# target ("# Session check for auth_request — internal only, never
# client-reachable"). The pre-fix runbook told the operator to delete only
# the block below it, so a literal follow-along leaves the comment behind.
# expect_absent's whole-file grep used to match inside comments too, so that
# leftover line contains the string "auth_request" and aborted --verify on
# an otherwise perfectly correct, working cutover.
# nginx-after-teardown-stray-comment.conf is exactly that: the after-fixture
# with the same comment line re-inserted where it used to sit, and nothing
# else different. It must pass now that count_of strips comment lines before
# counting.
f="$(work nginx-after-teardown-stray-comment.conf)"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --verify >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" = 0 ] && pass "--verify accepts a correct cutover with a leftover comment" \
              || fail "--verify ABORTED a correct cutover over a leftover comment (got rc=$rc)"

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

# The case above only exercises the TEST_MODE=1 branch, which never touches
# pm2 at all — "pm2 stop" -> "pm2 delete" is a change entirely inside the
# TEST_MODE=0 branch, so nothing above can catch it (confirmed by mutation:
# changing it broke zero selftest cases). --stop-next stopping (not
# deleting) is load-bearing in three separate places that all say the same
# thing and none of which is enforced by a test: retire-next.sh's own
# comments, and next-teardown.md §6/§8 — §8's rollback is `pm2 start
# localfinds`, which only works if the process definition still exists.
#
# This exercises the live (TEST_MODE=0) branch with everything on PATH
# stubbed — a pm2 stub that both answers `describe` (so the script takes the
# "stop" branch, not "already done") and logs every argv it was called
# with, and a curl stub that inspects its own last argument (the requested
# URL) and returns the status/body each of --stop-next's four probes needs
# to pass cleanly, so the run completes and the pm2 log can be inspected
# without hitting any real network or process.
PM2_ARGV_LOG="$(mktemp)"
LIVE_STUBS="$(mktemp -d)"
cat > "$LIVE_STUBS/pm2" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$PM2_ARGV_LOG"
exit 0
EOF
chmod +x "$LIVE_STUBS/pm2"

cat > "$LIVE_STUBS/curl" <<'CURLEOF'
#!/usr/bin/env bash
# Last argument is always the requested URL for every curl invocation this
# script makes. Route by URL, not by flags: the direct Next probe
# (127.0.0.1:3001) must read as "nothing answered" (curl's own 000), the
# catch-all probe must read as a non-Next body, everything else 200.
url="${!#}"
case "$url" in
  *127.0.0.1:3001*) printf '000' ;;
  *__teardown_probe__*) printf '<h1>Not Found</h1>' ;;
  *) printf '200' ;;
esac
CURLEOF
chmod +x "$LIVE_STUBS/curl"

f="$(work nginx-with-next.conf)"
out="$(PATH="$LIVE_STUBS:$PATH" RETIRE_NEXT_TEST=0 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --stop-next 2>&1)" && rc=0 || rc=$?
check "--stop-next (live path, stubbed) exits 0" "$rc" "0"
grep -qxF "stop localfinds" "$PM2_ARGV_LOG" \
  && pass "--stop-next invoked 'pm2 stop localfinds'" \
  || fail "--stop-next did not invoke 'pm2 stop localfinds' (log: $(cat "$PM2_ARGV_LOG" | tr '\n' ';'))"
grep -qF "delete" "$PM2_ARGV_LOG" \
  && fail "--stop-next invoked 'pm2 delete' (log: $(cat "$PM2_ARGV_LOG" | tr '\n' ';'))" \
  || pass "--stop-next never invoked 'pm2 delete'"

# The stub above satisfies all four post-stop probes, so their "ok" lines
# are also the only offline-reachable proof that each call site still
# exists at all — a deleted probe line wouldn't make the run exit non-zero
# (there would just be one fewer thing checked), so rc alone can't catch it.
printf '%s' "$out" | grep -qF 'ok  / after pm2 stop -> 200' \
  && pass "--stop-next's / probe ran" || fail "--stop-next's / probe did not run"
printf '%s' "$out" | grep -qF 'ok  /robots.txt after pm2 stop (via the catch-all) -> 200' \
  && pass "--stop-next's /robots.txt probe ran" \
  || fail "--stop-next's /robots.txt probe did not run"
printf '%s' "$out" | grep -qF 'ok  catch-all after pm2 stop -> no Next markers' \
  && pass "--stop-next's catch-all body probe ran" \
  || fail "--stop-next's catch-all body probe did not run"
printf '%s' "$out" | grep -qF 'ok  Next backend (127.0.0.1:3001) -> no connection (not serving)' \
  && pass "--stop-next's direct Next-port probe ran" \
  || fail "--stop-next's direct Next-port probe did not run"

rm -f "$PM2_ARGV_LOG"
rm -rf "$LIVE_STUBS"

# --stop-next used to run its four probes only inside the branch where it had
# something to stop (`elif pm2 describe ...; then ... probes`); the "already
# done" branch printed a line and returned, probing nothing. That shape is
# precisely the one next-teardown.md §9 hits: at T+1, Next is normally
# already stopped, and §9 is the gate on the irreversible wave-2 deletion —
# re-running --stop-next there needs to re-establish the fact, not skip the
# check because there was nothing left to stop. The restructure fixed this,
# but nothing above proves it: every case up to here either uses TEST_MODE=1
# (skips pm2 and the probes entirely) or a pm2 stub whose `describe` always
# succeeds (takes the "stop" branch). This is the "already done" branch,
# stubbed the same way, with `describe` failing instead.
PM2_ARGV_LOG="$(mktemp)"
LIVE_STUBS="$(mktemp -d)"
cat > "$LIVE_STUBS/pm2" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$PM2_ARGV_LOG"
case "\$1" in
  describe) exit 1 ;;  # no such process — the "already done" branch
  *) exit 0 ;;
esac
EOF
chmod +x "$LIVE_STUBS/pm2"

cat > "$LIVE_STUBS/curl" <<'CURLEOF'
#!/usr/bin/env bash
url="${!#}"
case "$url" in
  *127.0.0.1:3001*) printf '000' ;;
  *__teardown_probe__*) printf '<h1>Not Found</h1>' ;;
  *) printf '200' ;;
esac
CURLEOF
chmod +x "$LIVE_STUBS/curl"

f="$(work nginx-with-next.conf)"
out="$(PATH="$LIVE_STUBS:$PATH" RETIRE_NEXT_TEST=0 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --stop-next 2>&1)" && rc=0 || rc=$?
check "--stop-next (already stopped, live path) exits 0" "$rc" "0"
printf '%s' "$out" | grep -qF 'already done (no pm2 localfinds)' \
  && pass "--stop-next reports already done when pm2 has no such process" \
  || fail "--stop-next did not report 'already done'"
grep -qF "stop" "$PM2_ARGV_LOG" \
  && fail "--stop-next invoked 'pm2 stop' with no process to stop (log: $(cat "$PM2_ARGV_LOG" | tr '\n' ';'))" \
  || pass "--stop-next did not invoke 'pm2 stop' with no process to stop"
# The point of the restructure: all four probes still ran, even though there
# was nothing to stop. Before the fix, none of these lines would appear.
printf '%s' "$out" | grep -qF 'ok  / after pm2 stop -> 200' \
  && pass "--stop-next's / probe ran with no process to stop" \
  || fail "--stop-next's / probe did NOT run with no process to stop"
printf '%s' "$out" | grep -qF 'ok  /robots.txt after pm2 stop (via the catch-all) -> 200' \
  && pass "--stop-next's /robots.txt probe ran with no process to stop" \
  || fail "--stop-next's /robots.txt probe did NOT run with no process to stop"
printf '%s' "$out" | grep -qF 'ok  catch-all after pm2 stop -> no Next markers' \
  && pass "--stop-next's catch-all body probe ran with no process to stop" \
  || fail "--stop-next's catch-all body probe did NOT run with no process to stop"
printf '%s' "$out" | grep -qF 'ok  Next backend (127.0.0.1:3001) -> no connection (not serving)' \
  && pass "--stop-next's direct Next-port probe ran with no process to stop" \
  || fail "--stop-next's direct Next-port probe did NOT run with no process to stop"

rm -f "$PM2_ARGV_LOG"
rm -rf "$LIVE_STUBS"

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

# expect_no_connection is --stop-next's mechanism-independent check that
# Next itself isn't answering on :3001: 000 (curl couldn't connect) is the
# ONLY passing input; any real status — including a 5xx, which would mean
# something (even a dying Next) is still listening — must fail.
( . "$SCRIPT" --source-only; expect_no_connection "x" "000" ) >/dev/null 2>&1 \
  && pass "expect_no_connection accepts curl's 000 (no answer)" \
  || fail "expect_no_connection rejected curl's 000"
( . "$SCRIPT" --source-only; expect_no_connection "x" "200" ) >/dev/null 2>&1 \
  && fail "expect_no_connection accepted 200 (Next is still answering)" \
  || pass "expect_no_connection rejects 200"
( . "$SCRIPT" --source-only; expect_no_connection "x" "502" ) >/dev/null 2>&1 \
  && fail "expect_no_connection accepted 502 (something is still answering)" \
  || pass "expect_no_connection rejects 502"
( . "$SCRIPT" --source-only; expect_no_connection "x" "" ) >/dev/null 2>&1 \
  && fail "expect_no_connection accepted an empty status" \
  || pass "expect_no_connection rejects an empty status"

[ "$FAIL" = 0 ] && echo "SELFTEST PASS" || echo "SELFTEST FAIL"
exit "$FAIL"
