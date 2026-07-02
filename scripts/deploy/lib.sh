# Shared helpers for the deploy pipeline. Sourced by the stage scripts.
# Loads infra config from data/config/deploy.env (gitignored) so committed
# scripts carry no host/path details.
set -euo pipefail

DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_CONFIG="$DEPLOY_ROOT/data/config/deploy.env"

if [ ! -f "$DEPLOY_CONFIG" ]; then
  echo "deploy: missing $DEPLOY_CONFIG" >&2
  echo "deploy: copy data/config/deploy.env.example to data/config/deploy.env and fill it in" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$DEPLOY_CONFIG"

: "${DEPLOY_HOST:?set in deploy.env}"
: "${DEPLOY_PATH:?set in deploy.env}"
: "${DEPLOY_NVM_PREFIX:?set in deploy.env}"
: "${DEPLOY_PM2_NAME:?set in deploy.env}"

DRY_RUN=0
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=1
done

# Run a command on the server inside the nvm prefix and the app directory.
remote() {
  local cmd="$DEPLOY_NVM_PREFIX cd \"$DEPLOY_PATH\" && $*"
  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY remote> $cmd"
  else
    ssh "$DEPLOY_HOST" "$cmd"
  fi
}
