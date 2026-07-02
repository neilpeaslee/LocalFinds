#!/usr/bin/env bash
# Deploy-code stage: ship the committed tree, install/build/reload on the server.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$DEPLOY_ROOT"

# Detect whether package-lock changed BEFORE rsync (after rsync they'd match).
LOCAL_LOCK="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ "$DRY_RUN" = 1 ]; then
  REMOTE_LOCK=""
else
  REMOTE_LOCK="$(ssh "$DEPLOY_HOST" "sha256sum '$DEPLOY_PATH/package-lock.json' 2>/dev/null | cut -d' ' -f1" || true)"
fi

echo "deploy-code: rsync committed tree"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY rsync> git ls-files -> $DEPLOY_HOST:$DEPLOY_PATH/"
else
  rsync -az --files-from=<(git ls-files) ./ "$DEPLOY_HOST:$DEPLOY_PATH/"
fi

echo "deploy-code: rsync gitignored config reals (region/categories/towns/boundaries + map themes)"
CONFIG_REALS=(data/config/region.md data/config/categories.json data/config/towns.json data/config/town-boundaries.json)
# map-categories.json is OPTIONAL (readers fall back to the committed .example), so
# append it only once a real exists — but never let its absence break a deploy the
# way a missing required real (above) loudly should.
if [ -f data/config/map-categories.json ]; then
  CONFIG_REALS+=(data/config/map-categories.json)
fi
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY rsync> ${CONFIG_REALS[*]} -> $DEPLOY_HOST:$DEPLOY_PATH/data/config/"
else
  rsync -az "${CONFIG_REALS[@]}" "$DEPLOY_HOST:$DEPLOY_PATH/data/config/"
fi

if [ "$LOCAL_LOCK" != "$REMOTE_LOCK" ]; then
  echo "deploy-code: package-lock changed — npm ci"
  remote "npm ci"
else
  echo "deploy-code: package-lock unchanged — skipping npm ci"
fi

echo "deploy-code: build"
remote "npm run build -w @localfinds/web"

echo "deploy-code: done (reload happens after migrate)"
