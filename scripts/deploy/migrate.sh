#!/usr/bin/env bash
# Migrate stage: dump the precious localfinds schema, apply versioned SQL migrations
# via the tracked runner, then reload the app. Runs AFTER deploy-code (the migration
# files + pg-backup.sh must be on the box first). Connects to the `localfinds` DB as
# the localfinds role via a PASSWORD-FREE DSN sourced ON THE BOX from ~/localfinds-db.env;
# the password comes from ~/.pgpass (chmod 600) — never in a committed script, argv, or env.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$DEPLOY_ROOT"

echo "migrate: pre-migration dump of the localfinds schema (keep 10)"
remote "bash scripts/deploy/pg-backup.sh predeploy 10"

echo "migrate: applying migrations on prod"
remote "set -a && . \"\$HOME/localfinds-db.env\" && set +a && npx tsx packages/db/src/migrate.ts"

echo "migrate: reload + verify"
remote "pm2 reload $DEPLOY_PM2_NAME && pm2 save"
if [ "$DRY_RUN" != 1 ]; then
  curl -sS -o /dev/null -w "GET %{http_code}\n"  "https://localfinds.me/"
  curl -sS -o /dev/null -w "POST %{http_code}\n" -X POST "https://localfinds.me/"
fi

echo "migrate: done"
