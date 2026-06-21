#!/usr/bin/env bash
# Sync-content stage: ship a consistent local snapshot and merge it into prod
# (discovery data only; prod feedback + finds.status are preserved). Backs up
# the prod DB first.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$DEPLOY_ROOT"

SNAP="/tmp/localfinds-sync.db"
INCOMING_REL="data/.sync-incoming.db"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "sync-content: snapshot local DB"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY local> sqlite3 data/localfinds.db .backup $SNAP"
else
  sqlite3 data/localfinds.db ".backup '$SNAP'"
fi

echo "sync-content: ship snapshot -> $INCOMING_REL"
push_file "$SNAP" "$INCOMING_REL"

echo "sync-content: backup prod DB -> ${DEPLOY_DB}.bak-${STAMP}"
remote "sqlite3 ${DEPLOY_DB} \".backup '${DEPLOY_DB}.bak-${STAMP}'\""

echo "sync-content: merge on prod"
remote "npx tsx packages/db/src/sync-merge.ts '${INCOMING_REL}' '${DEPLOY_DB}'"

echo "sync-content: cleanup + reload"
remote "rm -f '${INCOMING_REL}'"
remote "pm2 reload $DEPLOY_PM2_NAME"

echo "sync-content: done"
