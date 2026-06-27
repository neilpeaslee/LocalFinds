#!/usr/bin/env bash
# Sync-content stage: ship a consistent local snapshot and merge it into prod
# (discovery data only; prod feedback + finds.status are preserved), then rsync
# the agent runtime files (run transcripts, notes, config) that live outside the
# DB. Backs up the prod DB first.
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

# Ship the non-DB runtime files: agent run transcripts (data/agents/*/runs/*.jsonl)
# and notes power prod's /agents pages. Exclude the DB (handled by the merge), the
# temp snapshot, and config/deploy.env (local infra, not for prod). Also exclude
# data/'s own private git repo (data/.git + .gitignore — see the localfinds-data
# repo: it mirrors to gitudl+henry, must never ship to prod) and the transient
# .staging-* dirs the interviewer creates. No --delete: additive only.
echo "sync-content: ship agent runtime files (transcripts, notes, config)"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY rsync> data/ (excl. localfinds.db*, .sync-incoming.db, config/deploy.env, .git, .gitignore, .staging-*) -> $DEPLOY_HOST:$DEPLOY_PATH/data/"
else
  rsync -az \
    --exclude='localfinds.db' --exclude='localfinds.db-wal' --exclude='localfinds.db-shm' \
    --exclude='.sync-incoming.db' --exclude='config/deploy.env' \
    --exclude='.git' --exclude='.gitignore' --exclude='.staging-*' \
    data/ "$DEPLOY_HOST:$DEPLOY_PATH/data/"
fi

echo "sync-content: cleanup + reload"
remote "rm -f '${INCOMING_REL}'"
remote "pm2 reload $DEPLOY_PM2_NAME"

echo "sync-content: done"
