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
while read -r label line; do
  f="$(work nginx-after-teardown.conf)"
  printf '%s\n' "$line" >> "$f"
  RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --verify >/dev/null 2>&1 && rc=0 || rc=$?
  [ "$rc" != 0 ] && pass "--verify catches reintroduced $label" \
                 || fail "--verify MISSED reintroduced $label"
done <<'ROWS'
next-backend     proxy_pass http://127.0.0.1:3001;
auth_request     auth_request /auth/check;
write-gate       error_page 418 = @write_gate;
login-redirect   location @login { return 302 /auth/log-in; }
runs-sse         location /api/runs/ { proxy_pass http://127.0.0.1:4000; }
next-assets      location /_next/ { proxy_pass http://127.0.0.1:4000; }
ROWS

# Removing a Phoenix location must also fail — the invariants cut both ways.
for loc in "location /live {" "location = /feed {" "location ^~ /agents/ {"; do
  f="$(work nginx-after-teardown.conf)"
  grep -vF "$loc" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --verify >/dev/null 2>&1 && rc=0 || rc=$?
  [ "$rc" != 0 ] && pass "--verify catches a missing '$loc'" \
                 || fail "--verify MISSED a missing '$loc'"
done

[ "$FAIL" = 0 ] && echo "SELFTEST PASS" || echo "SELFTEST FAIL"
exit "$FAIL"
