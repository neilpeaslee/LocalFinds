#!/usr/bin/env bash
# retire-legacy-osm.sh — one-shot retirement of the SQLite-era osm-api stack on udl.
# Run ON THE BOX as root:  sudo bash retire-legacy-osm.sh [--check]
#   --check : read-only report of current state + exactly what would change.
# Idempotent: each phase skips cleanly if already done; every mutation is preceded
# by a dated backup. Deliberately untouched: osmapi user, /var/log/osm-api,
# /etc/cron.d/osm-api-replication, the osm_api PG role, everything chatapi.
# Spec: docs/superpowers/specs/2026-07-19-legacy-osm-retirement-design.md
set -euo pipefail

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

TS="$(date +%Y%m%d-%H%M%S)"
UNIT=/etc/systemd/system/osm-api.service
ENVDIR=/etc/osm-api
REPL=/usr/local/bin/osm-api-replication.sh
NGX=/etc/nginx/sites-available/localfinds.us
OPT=/opt/localfinds
BK=/home/neil/localfinds-backups
TAR="$BK/opt-localfinds-final-$TS.tar.gz"

[ "$(id -u)" -eq 0 ] || { echo "ABORT: must run as root" >&2; exit 1; }

say()   { printf '%s\n' "$*"; }
phase() { printf '\n=== %s ===\n' "$*"; }

phase "P0 preflight"
curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3001/ \
  || { echo "ABORT: web app not answering on :3001 — box not healthy, not proceeding" >&2; exit 1; }
say "web app on :3001: OK"
for f in "unit:$UNIT" "envdir:$ENVDIR" "opt:$OPT"; do
  [ -e "${f#*:}" ] && say "${f%%:*}: present" || say "${f%%:*}: absent (phase will skip)"
done
grep -q osm_businesses "$REPL" 2>/dev/null \
  && say "replication script: references osm_businesses" \
  || say "replication script: no osm_businesses reference (phase will skip)"
grep -q 'location /osm/' "$NGX" 2>/dev/null \
  && say "nginx: /osm/ block present" \
  || say "nginx: no /osm/ block (phase will skip)"

if [ "$CHECK" -eq 1 ]; then
  phase "CHECK: replication script lines sed would delete"
  grep -n osm_businesses "$REPL" 2>/dev/null || say "(none)"
  phase "CHECK: nginx lines sed would delete"
  sed -n '/location \/osm\//,/^[[:space:]]*}/p' "$NGX" 2>/dev/null || say "(none)"
  phase "CHECK: /opt/localfinds size to archive (excl. .venv)"
  [ -d "$OPT" ] && du -sh --exclude='.venv' "$OPT" || say "(absent)"
  say ""
  say "CHECK ONLY — nothing changed. Re-run without --check to execute."
  exit 0
fi

phase "P1 osm-api.service"
if [ -f "$UNIT" ]; then
  systemctl disable --now osm-api.service
  cp -a "$UNIT" "$BK/osm-api.service.bak-$TS" && chown neil:neil "$BK/osm-api.service.bak-$TS"
  rm -f "$UNIT"
  systemctl daemon-reload
  systemctl reset-failed osm-api.service 2>/dev/null || true
  say "stopped+disabled, unit removed (backup: $BK/osm-api.service.bak-$TS)"
else
  say "already done (no unit file)"
fi
if [ -d "$ENVDIR" ]; then rm -rf "$ENVDIR"; say "$ENVDIR removed"; else say "$ENVDIR already gone"; fi

phase "P2 replication script"
if grep -q osm_businesses "$REPL" 2>/dev/null; then
  cp -a "$REPL" "$REPL.bak-$TS"
  sed -i '/osm_businesses/d' "$REPL"
  say "diff vs backup:"
  diff "$REPL.bak-$TS" "$REPL" || true
  grep -q osm_businesses "$REPL" \
    && { echo "ABORT: osm_businesses still present after edit" >&2; exit 1; }
  bash -n "$REPL" \
    || { cp -a "$REPL.bak-$TS" "$REPL"; echo "ABORT: edited script fails bash -n; original restored" >&2; exit 1; }
  say "edited OK (backup: $REPL.bak-$TS)"
else
  say "already done (no osm_businesses reference)"
fi

phase "P3 nginx /osm/ block"
if grep -q 'location /osm/' "$NGX" 2>/dev/null; then
  cp -a "$NGX" "$NGX.bak-$TS"
  sed -i '/location \/osm\//,/^[[:space:]]*}/d' "$NGX"
  if nginx -t; then
    systemctl reload nginx
    say "block removed, nginx reloaded (backup: $NGX.bak-$TS)"
  else
    cp -a "$NGX.bak-$TS" "$NGX"
    echo "ABORT: nginx -t failed; config restored, nginx NOT reloaded" >&2
    exit 1
  fi
else
  say "already done (no /osm/ block)"
fi

phase "P4 /opt/localfinds"
if [ -d "$OPT" ]; then
  tar czf "$TAR" --exclude='.venv' -C / opt/localfinds
  chown neil:neil "$TAR"
  say "archived: $TAR ($(du -h "$TAR" | cut -f1))"
  rm -rf "$OPT"
  say "$OPT removed"
else
  say "already done (no $OPT)"
fi

phase "P5 summary"
say "retired : osm-api.service, /etc/osm-api, nginx /osm/ block, /opt/localfinds (archived)"
say "kept    : replication cron+script (osm_businesses refresh removed; next run 04:17 UTC),"
say "          osmapi user, /var/log/osm-api, osm_api PG role, chatapi (untouched)"
say "next    : Claude drops MATERIALIZED VIEW public.osm_businesses (non-root, osm_api owns it)"
