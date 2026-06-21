#!/usr/bin/env bash
# Full deploy: gate -> migrate -> deploy-code -> sync-content. Aborts on the
# first failure. Forwards --dry-run to every stage.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "deploy: [1/4] gate"
bash "$DIR/gate.sh" "$@"
echo "deploy: [2/4] migrate"
bash "$DIR/migrate.sh" "$@"
echo "deploy: [3/4] deploy-code"
bash "$DIR/deploy-code.sh" "$@"
echo "deploy: [4/4] sync-content"
bash "$DIR/sync-content.sh" "$@"
echo "deploy: complete"
