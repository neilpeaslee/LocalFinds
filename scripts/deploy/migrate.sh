#!/usr/bin/env bash
# Migrate stage: apply versioned migrations to local + prod DBs. Backs up the
# prod DB first. Non-interactive (no drizzle-kit push prompt).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$DEPLOY_ROOT"

echo "migrate: applying migrations locally"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY local> npx tsx packages/db/src/migrate.ts"
else
  ( cd packages/db && npx tsx src/migrate.ts )
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
echo "migrate: backing up prod DB -> ${DEPLOY_DB}.bak-${STAMP}"
remote "sqlite3 ${DEPLOY_DB} \".backup '${DEPLOY_DB}.bak-${STAMP}'\""

echo "migrate: applying migrations on prod"
remote "npx tsx packages/db/src/migrate.ts"

echo "migrate: done"
