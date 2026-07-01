#!/usr/bin/env bash
# Migrate stage: dump prod Postgres, apply versioned SQL migrations via the tracked
# runner, then reload the app so it serves the migrated schema. Runs AFTER
# deploy-code — the migration files must be on the box before they're applied.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$DEPLOY_ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
echo "migrate: dumping prod DB -> data/pg-${DEPLOY_PGDATABASE}.dump.bak-${STAMP}"
remote "pg_dump -Fc '${DEPLOY_PGDATABASE}' > 'data/pg-${DEPLOY_PGDATABASE}.dump.bak-${STAMP}'"

echo "migrate: applying migrations on prod"
remote "LOCALFINDS_DATABASE_URL=postgres:///${DEPLOY_PGDATABASE} npx tsx packages/db/src/migrate.ts"

echo "migrate: reload + verify"
remote "pm2 reload $DEPLOY_PM2_NAME && pm2 save"
if [ "$DRY_RUN" != 1 ]; then
  curl -sS -o /dev/null -w "GET %{http_code}\n"  "https://localfinds.peaslee.org/"
  curl -sS -o /dev/null -w "POST %{http_code}\n" -X POST "https://localfinds.peaslee.org/"
fi

echo "migrate: done"
