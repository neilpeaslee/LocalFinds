#!/usr/bin/env bash
# Deploy the Phoenix API: build the release on the box from the already-shipped
# checkout (run deploy-code.sh first), then restart the systemd service.
# NO MIGRATE STEP, on purpose: Phoenix owns no schema (SP7 design). Schema
# changes go through scripts/deploy/migrate.sh and the TS runner only.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${DEPLOY_MIX_PREFIX:?set in deploy.env (mise shims PATH prefix)}"

echo "deploy-api: building release on the box"
remote "${DEPLOY_MIX_PREFIX} cd phoenix && mix local.hex --force --if-missing && \
  mix deps.get --only prod && MIX_ENV=prod mix release --overwrite"

echo "deploy-api: restarting service"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY ssh> sudo systemctl restart localfinds-api"
else
  ssh "$DEPLOY_HOST" "sudo systemctl restart localfinds-api"
fi

echo "deploy-api: verify"
if [ "$DRY_RUN" != 1 ]; then
  sleep 3
  curl -sS -o /dev/null -w "health %{http_code}\n" "https://api.localfinds.me/health"
  curl -sS -o /dev/null -w "noauth %{http_code}\n" "https://api.localfinds.me/osm/places?town=Rockland"
fi

echo "deploy-api: done"
