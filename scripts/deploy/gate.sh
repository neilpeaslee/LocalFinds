#!/usr/bin/env bash
# Pre-deploy gate: refuse to deploy unless the branch is clean main and both
# tests AND typecheck pass across all packages. Local-only; no SSH, no config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "gate: on '$branch', not 'main' — refusing to deploy" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "gate: working tree not clean — deploy ships committed files only" >&2
  git status --short >&2
  exit 1
fi

echo "gate: running tests"
npm test

echo "gate: typechecking all packages"
for p in packages/db packages/agents apps/web; do
  echo "gate: tsc --noEmit ($p)"
  ( cd "$p" && npx tsc --noEmit )
done

echo "gate: PASS"
