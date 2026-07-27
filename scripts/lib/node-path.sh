# Shared PATH extension: prepends the common places a `node`/`npx` install
# lives (nvm's, primarily) onto PATH. Sourced - not executed - by both
# scripts/run-agents.sh (the cron/dev entrypoint) and the shell script
# Localfinds.Agents.Spawner.System generates for the Phoenix release (see
# phoenix/lib/localfinds/agents/spawner/system.ex): both invoke `npx` bare,
# and neither cron's minimal PATH nor systemd's default PATH for a unit with
# `User=` includes nvm's node.
#
# POSIX sh only - no bashisms. The spawner's script runs under /bin/sh, which
# is dash on Ubuntu, not bash. Because this file is sourced into the caller's
# shell rather than exec'd, it must have no shebang-dependent behavior and
# must never `exit` - that would kill the caller's shell, not just this file.
#
# Depends on $HOME being set by the caller's environment: for run-agents.sh
# that's the invoking user's (or cron's, which sets HOME) login environment;
# for the Phoenix-spawned script that's systemd, which sets HOME for any unit
# with `User=`. If HOME is unset/empty, or no nvm install is found, this
# degrades safely - PATH is left (mostly) as it was, nothing errors.

export PATH="${HOME:-}/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -n "${HOME:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  latest_nvm_node=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$latest_nvm_node" ] && export PATH="$latest_nvm_node:$PATH"
fi
