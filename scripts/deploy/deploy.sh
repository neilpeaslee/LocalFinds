#!/usr/bin/env bash
# Full deploy: gate -> deploy-code -> migrate. Aborts on the first failure.
# Forwards --dry-run to every stage. Code ships (deploy-code) before migrations
# apply (migrate); the app reloads after migrate, so it always serves the migrated
# schema.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "deploy: [1/3] gate"
bash "$DIR/gate.sh" "$@"
echo "deploy: [2/3] deploy-code"
bash "$DIR/deploy-code.sh" "$@"
echo "deploy: [3/3] migrate"
bash "$DIR/migrate.sh" "$@"
echo "deploy: complete"
