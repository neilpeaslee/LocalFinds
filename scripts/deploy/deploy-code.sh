#!/usr/bin/env bash
# Deploy-code stage: ship the committed tree, install/build/reload on the server.
# Ship mechanism is git (2026-07-02): push local main to the bare repo on the box,
# then hard-sync the checkout (fetch + reset --hard + git clean) so the box tree
# always equals the committed tree — deleted files disappear, stale files are
# structurally impossible. Protection is two-layer: .gitignore (clean without -x
# never touches ignored files: data/**, .env*, node_modules/, .next/) plus the
# explicit -e excludes below for the two irreplaceable ones.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$DEPLOY_ROOT"

# Detect whether package-lock changed BEFORE the sync (after it they'd match).
LOCAL_LOCK="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ "$DRY_RUN" = 1 ]; then
  REMOTE_LOCK=""
else
  REMOTE_LOCK="$(ssh "$DEPLOY_HOST" "sha256sum '$DEPLOY_PATH/package-lock.json' 2>/dev/null | cut -d' ' -f1" || true)"
fi

echo "deploy-code: ship main via git (push -> fetch -> reset --hard -> clean)"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY git> git push $DEPLOY_GIT_REMOTE main"
else
  # Bootstrap guard: a clear error beats git's confusing one if the one-time
  # git-checkout bootstrap (deploy-localfinds skill) hasn't run on this box.
  if ! ssh "$DEPLOY_HOST" "git -C '$DEPLOY_PATH' rev-parse --is-inside-work-tree" >/dev/null 2>&1; then
    echo "deploy-code: $DEPLOY_PATH is not a git checkout — run the one-time git-checkout bootstrap (deploy-localfinds skill) first" >&2
    exit 1
  fi
  # Never auto-force: a rejected push (diverged main) aborts the deploy here.
  git push "$DEPLOY_GIT_REMOTE" main
fi
remote "git fetch origin main && git reset --hard FETCH_HEAD && git clean -fd -e data -e apps/web/.env.production"

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

echo "deploy-code: rsync agent interest profiles (gitignored PII -> box, behind the /agents steward gate)"
# profile.md files live in per-agent subdirs, so -R (relative) reconstructs
# data/agents/<name>/profile.md under $DEPLOY_PATH. nullglob so a no-profile state
# expands to nothing (not a literal glob); git clean -e data (above) leaves them
# in place on later deploys.
shopt -s nullglob
PROFILE_REALS=(data/agents/*/profile.md)
shopt -u nullglob
if [ ${#PROFILE_REALS[@]} -eq 0 ]; then
  echo "deploy-code: no agent profiles to publish (skipping)"
elif [ "$DRY_RUN" = 1 ]; then
  echo "DRY rsync> ${PROFILE_REALS[*]} -> $DEPLOY_HOST:$DEPLOY_PATH/ (relative)"
else
  rsync -azR "${PROFILE_REALS[@]}" "$DEPLOY_HOST:$DEPLOY_PATH/"
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
