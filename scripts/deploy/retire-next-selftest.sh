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

echo "== del_block =="

# One-liner block: @login must lose exactly one line and nothing else.
f="$(work nginx-with-next.conf)"
before="$(wc -l < "$f")"
( . "$SCRIPT" --source-only; del_block "$f" "@login" )
after="$(wc -l < "$f")"
check "@login removes exactly 1 line" "$((before - after))" "1"
check "@login gone" "$(grep -c '@login' "$f")" "0"
check "@write_gate survived @login delete" "$(grep -c 'location @write_gate' "$f")" "1"

# Braced block: /api/runs/ is 8 lines including its braces.
f="$(work nginx-with-next.conf)"
before="$(wc -l < "$f")"
( . "$SCRIPT" --source-only; del_block "$f" "/api/runs/" )
after="$(wc -l < "$f")"
check "/api/runs/ removes 8 lines" "$((before - after))" "8"
check "/api/runs/ gone" "$(grep -c 'location /api/runs/' "$f")" "0"
check "@login survived /api/runs/ delete" "$(grep -c '@login' "$f")" "1"

# Absent block: returns 1 and changes nothing.
f="$(work nginx-with-next.conf)"
before="$(md5sum < "$f")"
( . "$SCRIPT" --source-only; del_block "$f" "/_next/" ) && rc=0 || rc=1
check "absent block returns 1" "$rc" "1"
check "absent block changed nothing" "$(md5sum < "$f")" "$before"

echo "== del_block: a comment naming the token must not hijack the match =="

# A comment mentioning the real /api/runs/ block, planted directly above the
# UNRELATED /live block (the earliest location in the file). An unanchored
# substring match finds the comment first (it comes first in the file) and
# deletes /live instead of the real /api/runs/ block, while still reporting
# success — exactly the defect reported against production's hand-maintained
# nginx config.
f="$(work nginx-with-next.conf)"
sed -i '\|location /live {|i\    # docs: see location /api/runs/ for the polling endpoint' "$f"
before="$(wc -l < "$f")"
( . "$SCRIPT" --source-only; del_block "$f" "/api/runs/" )
after="$(wc -l < "$f")"
check "commented /api/runs/ ref: real block removed" "$(grep -c 'location /api/runs/ {' "$f")" "0"
check "commented /api/runs/ ref: /live untouched" "$(grep -c 'proxy_set_header Connection "upgrade"' "$f")" "1"
check "commented /api/runs/ ref: exactly 8 lines removed" "$((before - after))" "8"

# Same shape of attack against the one-liner form: a comment naming @login,
# planted directly above the UNRELATED /assets block.
f="$(work nginx-with-next.conf)"
sed -i '\|location /assets {|i\    # legacy: location @login used to redirect here' "$f"
before="$(wc -l < "$f")"
( . "$SCRIPT" --source-only; del_block "$f" "@login" )
after="$(wc -l < "$f")"
check "commented @login ref: real one-liner removed" "$(grep -c 'return 302 /auth/log-in' "$f")" "0"
check "commented @login ref: /assets untouched" "$(grep -c 'location /assets {' "$f")" "1"
check "commented @login ref: comment itself untouched" "$(grep -c 'legacy: location @login used to redirect here' "$f")" "1"
check "commented @login ref: exactly 1 line removed" "$((before - after))" "1"

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
( . "$SCRIPT" --source-only; del_block "$f" "/" ) || true
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check aborts when the catch-all is missing" \
                || fail "--check accepted a config with no catch-all"

# A config already missing @write_gate must abort, not proceed. del_block
# only removes the `location @write_gate { ... }` block itself; the fixture
# also references @write_gate from the catch-all's `error_page 418 =
# @write_gate;`, so that reference must be stripped too or the fixed-string
# check still finds "@write_gate" in the file and never aborts.
f="$(work nginx-with-next.conf)"
( . "$SCRIPT" --source-only; del_block "$f" "@write_gate" ) || true
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

# The catch-all's OWN backend, repointed to a third port. 127.0.0.1:3001
# still appears elsewhere in the file (@write_gate, /api/runs/), so a
# whole-file substring check is satisfied while the catch-all itself is
# wrong — exactly the "plan is wrong about this box" case --check exists to
# catch. sed's range is scoped to the catch-all block only (4-space-indent
# "location / {" through the matching 4-space-indent "}"), so the OTHER
# 127.0.0.1:3001 occurrences are left untouched on purpose.
f="$(work nginx-with-next.conf)"
sed -i '/^    location \/ {$/,/^    }$/ s/127\.0\.0\.1:3001/127.0.0.1:5000/' "$f"
RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check aborts when the catch-all proxy_passes to the wrong port" \
                || fail "--check accepted a catch-all pointing at the wrong port"

# More than one `location / {`. Realistic, not hypothetical: the production
# site file may well carry a second `server { listen 80; ... }` for the
# HTTP->HTTPS redirect, which can legitimately contain its own bare
# `location /`. del_block's head -1 would only ever act on the first one.
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

echo "== brace-depth-aware block extraction (nested multi-line blocks) =="

# The catch-all with its `if` guard written across multiple lines, `}` alone
# on its own line, instead of the fixture's one-liner
# `if ($request_method !~ ^(GET|HEAD)$) { return 418; }`. A naive "first
# line matching ^[[:space:]]*}" search stops at the INNER brace and
# check_catch_all_backend reports "no proxy_pass in the block" against a
# config that is perfectly fine — nginx formatting is a matter of whoever
# last hand-edited the file, and this shape is realistic. --check must
# still exit 0. index() below is a literal substring match, not a regex, so
# none of the nginx-special characters ($, ^, (, ), |) need escaping.
f="$(work nginx-with-next.conf)"
awk '
  {
    if (index($0, "if ($request_method !~ ^(GET|HEAD)$) { return 418; }") > 0) {
      match($0, /^[[:space:]]*/)
      indent = substr($0, RSTART, RLENGTH)
      print indent "if ($request_method !~ ^(GET|HEAD)$) {"
      print indent "    return 418;"
      print indent "}"
    } else {
      print
    }
  }
' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
out="$(RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check 2>&1)" && rc=0 || rc=$?
check "--check handles a multi-line nested if in the catch-all" "$rc" "0"
[ "$(printf '%s' "$out" | grep -c 'does not proxy_pass')" = "0" ] \
  && pass "--check did not falsely report the catch-all's backend as wrong" \
  || fail "--check falsely reported the catch-all's backend as wrong"

# /api/runs/ with a nested multi-line `if` inside it (not present in the
# base fixture — injected here). del_block must remove the WHOLE block
# (through its own depth-matched closing brace, not the inner one), leaving
# the following block (@login) intact and total brace count balanced. The
# old first-line-that-looks-like-a-close search would stop at the inner
# `if`'s `}`, deleting only 5 of the block's 11 lines and orphaning the
# remaining proxy_pass/proxy_buffering/... directives plus a stray `}`.
f="$(work nginx-with-next.conf)"
start="$(grep -n '^    location /api/runs/ {$' "$f" | cut -d: -f1)"
awk -v n="$start" '
  { print }
  NR==n+1 {
    print "        if ($request_method = OPTIONS) {"
    print "            return 204;"
    print "        }"
  }
' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
before="$(wc -l < "$f")"
before_open="$(grep -o '{' "$f" | wc -l)"
before_close="$(grep -o '}' "$f" | wc -l)"
( . "$SCRIPT" --source-only; del_block "$f" "/api/runs/" )
after="$(wc -l < "$f")"
after_open="$(grep -o '{' "$f" | wc -l)"
after_close="$(grep -o '}' "$f" | wc -l)"
check "/api/runs/ with nested if: removes 11 lines" "$((before - after))" "11"
check "/api/runs/ with nested if: block gone" "$(grep -c 'location /api/runs/' "$f")" "0"
check "/api/runs/ with nested if: @login survived" "$(grep -c '@login' "$f")" "1"
check "/api/runs/ with nested if: braces stay balanced" \
  "$((before_open - after_open))" "$((before_close - after_close))"

echo "== brace-depth-aware block extraction: strings and comments are not structural =="

# `}` inside a quoted header value must not be mistaken for the block's own
# close. Without string-stripping this would truncate 3 lines early.
f="$(work nginx-with-next.conf)"
start="$(grep -n '^    location /api/runs/ {$' "$f" | cut -d: -f1)"
awk -v n="$start" '
  { print }
  NR==n+1 { print "        proxy_set_header X-Thing \"a}b\";" }
' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
before="$(wc -l < "$f")"
( . "$SCRIPT" --source-only; del_block "$f" "/api/runs/" )
after="$(wc -l < "$f")"
check "unmatched } in a quoted string: removes 9 lines" "$((before - after))" "9"
check "unmatched } in a quoted string: block gone" "$(grep -c 'location /api/runs/' "$f")" "0"
check "unmatched } in a quoted string: @login survived" "$(grep -c '@login' "$f")" "1"

# `{` inside a quoted header value must not push depth away from zero.
# Without string-stripping this would run the search past the block's real
# end looking for one extra `}` that doesn't structurally exist.
f="$(work nginx-with-next.conf)"
start="$(grep -n '^    location /api/runs/ {$' "$f" | cut -d: -f1)"
awk -v n="$start" '
  { print }
  NR==n+1 { print "        proxy_set_header X-Thing \"a{b\";" }
' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
before="$(wc -l < "$f")"
( . "$SCRIPT" --source-only; del_block "$f" "/api/runs/" )
after="$(wc -l < "$f")"
check "unmatched { in a quoted string: removes 9 lines" "$((before - after))" "9"
check "unmatched { in a quoted string: block gone" "$(grep -c 'location /api/runs/' "$f")" "0"
check "unmatched { in a quoted string: @login survived" "$(grep -c '@login' "$f")" "1"

# `}` inside a `#` comment must not be mistaken for the block's own close.
f="$(work nginx-with-next.conf)"
start="$(grep -n '^    location /api/runs/ {$' "$f" | cut -d: -f1)"
awk -v n="$start" '
  { print }
  NR==n+1 { print "        # note: closing brace looks like this: }" }
' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
before="$(wc -l < "$f")"
( . "$SCRIPT" --source-only; del_block "$f" "/api/runs/" )
after="$(wc -l < "$f")"
check "unmatched } in a # comment: removes 9 lines" "$((before - after))" "9"
check "unmatched } in a # comment: block gone" "$(grep -c 'location /api/runs/' "$f")" "0"
check "unmatched } in a # comment: @login survived" "$(grep -c '@login' "$f")" "1"

# A `#` INSIDE a quoted string must not start a comment — proves strings are
# stripped before comments, not the other way round. The string closes
# properly and is followed by a real, unquoted `}` on the same line; if
# comments were stripped first, the naive `#.*` match (not knowing it's
# inside quotes yet) would eat from the `#` to end of line, taking that real
# `}` down with it, and the search would run past line 2 to the block's
# outer close at line 4 instead of stopping where the true brace count says
# it should.
f="$(mktemp)"
cat > "$f" <<'EOF'
location /x {
    proxy_set_header X-Thing "a#b"; }
    proxy_pass http://127.0.0.1:3001;
}
EOF
end="$( . "$SCRIPT" --source-only; block_end_line "$f" 1 )"
check "# inside a quoted string is inert (strings stripped before comments)" "$end" "2"
rm -f "$f"

# The reviewer's worst case: four sibling blocks, an unmatched `{` in a
# comment inside /a, and a coincidental unmatched `}` in a comment inside
# /c. Naive brace counting (no string/comment stripping) sees /a's comment
# `{` as needing one more `}` than /a's own close provides, runs past /a and
# /b, and finds its "extra" close inside /c's comment — deleting /a, /b, and
# all of /c (11 lines) instead of just /a (4 lines).
f="$(mktemp)"
cat > "$f" <<'EOF'
server {
    location /a {
        # unmatched brace below for testing: {
        proxy_pass http://127.0.0.1:3001;
    }

    location /b {
        proxy_pass http://127.0.0.1:3001;
    }

    location /c {
        # unmatched brace below for testing: }
        proxy_pass http://127.0.0.1:3001;
    }

    location /d {
        proxy_pass http://127.0.0.1:3001;
    }
}
EOF
before="$(wc -l < "$f")"
( . "$SCRIPT" --source-only; del_block "$f" "/a" )
after="$(wc -l < "$f")"
check "four-block worst case: /a removes exactly 4 lines" "$((before - after))" "4"
check "four-block worst case: /a gone" "$(grep -c 'location /a {' "$f")" "0"
check "four-block worst case: /b survives" "$(grep -c 'location /b {' "$f")" "1"
check "four-block worst case: /c survives" "$(grep -c 'location /c {' "$f")" "1"
check "four-block worst case: /d survives" "$(grep -c 'location /d {' "$f")" "1"
rm -f "$f"

# An unterminated block: del_block (run as root against production) must
# fail loudly with its own clear diagnostic, never fall through to sed with
# an empty line number and let a raw sed error be the only signal.
f="$(mktemp)"
cat > "$f" <<'EOF'
location /x {
    proxy_pass http://127.0.0.1:3001;
EOF
before="$(md5sum < "$f")"
err="$( ( . "$SCRIPT" --source-only; del_block "$f" "/x" ) 2>&1 1>/dev/null )" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "del_block fails loudly on an unterminated block" \
                || fail "del_block silently succeeded on an unterminated block"
[ "$(printf '%s' "$err" | grep -ci 'sed:')" = "0" ] \
  && pass "del_block's failure is not a raw sed error" \
  || fail "del_block's failure leaked a raw sed error instead of a clear message"
printf '%s' "$err" | grep -qi 'unbalanced' \
  && pass "del_block's failure names the unbalanced-block problem" \
  || fail "del_block's failure did not explain the problem"
check "del_block: unterminated block changed nothing" "$(md5sum < "$f")" "$before"
rm -f "$f"

# Same guarantee for check_catch_all_backend, --check's own caller of
# block_end_line: an unterminated catch-all must abort with a clear message,
# not a raw sed error out of `sed -n ",p"` on an empty end line.
f="$(mktemp)"
cat > "$f" <<'EOF'
server {
    # @write_gate referenced here only to satisfy an earlier, unrelated check
    location / {
        proxy_pass http://127.0.0.1:3001;
EOF
out="$(RETIRE_NEXT_TEST=1 RETIRE_NEXT_NGX="$f" bash "$SCRIPT" --check 2>&1)" && rc=0 || rc=$?
[ "$rc" != 0 ] && pass "--check fails on an unterminated catch-all, not a sed error" \
                || fail "--check silently succeeded on an unterminated catch-all"
[ "$(printf '%s' "$out" | grep -ci 'sed:')" = "0" ] \
  && pass "--check's failure on an unterminated catch-all is not a raw sed error" \
  || fail "--check's failure leaked a raw sed error"
rm -f "$f"

[ "$FAIL" = 0 ] && echo "SELFTEST PASS" || echo "SELFTEST FAIL"
exit "$FAIL"
