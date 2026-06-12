#!/usr/bin/env bash
# Cron entrypoint: runs the full agent roster sequentially and appends to
# data/agents/cron.log. The CLI loads .env itself (ANTHROPIC_API_KEY etc.).
#
# Install (3 runs/day at 7:00, 12:00, 18:00) with `crontab -e`:
#   0 7,12,18 * * * /home/neil/Projects/LocalFinds/scripts/run-agents.sh
#
# Don't enable the schedule until data/config/region.md holds your real
# region and .env holds a real ANTHROPIC_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."

# cron's PATH usually lacks node; extend with common install locations.
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  latest_nvm_node=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$latest_nvm_node" ] && export PATH="$latest_nvm_node:$PATH"
fi

mkdir -p data/agents
{
  echo "=== run-agents $(date -Is) ==="
  status=0
  npx tsx packages/agents/src/cli.ts all "$@" || status=$?
  echo "=== done $(date -Is) (exit $status) ==="
  exit "$status"
} >> data/agents/cron.log 2>&1
