#!/usr/bin/env bash
# pull-localfinds-backups.sh — nightly pull of udl:~/localfinds-backups to henry.
# Runs ON HENRY (installed at ~/bin/, cron 17 5 * * * EDT = 09:17 UTC, one hour
# after the box's 08:17 UTC pg dump). The udl key is rrsync-restricted read-only
# to /home/neil/localfinds-backups, so "udl:/" IS that directory.
# No --delete: the box rotates itself (14 days); henry accumulates everything.
# Every run appends one OK/FAIL line to pull.log — silence is never success.
set -euo pipefail
DEST=/srv/data/localfinds-backups/pg
LOG=/srv/data/localfinds-backups/pull.log
mkdir -p "$DEST"
if out=$(rsync -a --timeout=60 udl:/ "$DEST/" 2>&1); then
  echo "$(date '+%F %T') OK  $(ls -1 "$DEST" | wc -l) files in pg/" >> "$LOG"
else
  echo "$(date '+%F %T') FAIL rsync: $out" >> "$LOG"
  exit 1
fi
