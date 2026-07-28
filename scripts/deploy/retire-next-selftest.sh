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

[ "$FAIL" = 0 ] && echo "SELFTEST PASS" || echo "SELFTEST FAIL"
exit "$FAIL"
