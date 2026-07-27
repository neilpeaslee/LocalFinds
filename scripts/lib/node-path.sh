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
#
# The nvm-version lookup below is guarded in two places against a
# .nvm/versions/node that exists but is empty (mid `nvm install`, or every
# version uninstalled) - a case where there is legitimately nothing to add
# to PATH, but which still trips `set -e`/`pipefail` (run-agents.sh runs
# with both; the Phoenix-spawned script does not, since it never sets -e)
# if left unguarded. Because this file is sourced rather than executed, an
# unguarded failure here would abort the *caller's* script right there -
# before it ever reaches the CLI invocation, with nothing written to its
# log:
#   1. `ls -d .../*/bin` exits non-zero for the unmatched glob, and
#      `pipefail` carries that through `sort -V | tail -1` into the
#      `latest_nvm_node=$(...)` assignment. `|| true` on that line absorbs
#      it - the assignment still correctly ends up empty.
#   2. Testing that empty result with `[ -n "$latest_nvm_node" ] &&
#      export ...` would itself be a standalone command whose exit status
#      is the (legitimately nonzero) test's status whenever there's nothing
#      to export - triggering -e a second time. Wrapping it in `if ... fi`
#      avoids this: an `if` whose condition is false, with no `else`, exits
#      zero - the second bullet's failure mode `||`/`&&` chaining doesn't
#      have.

export PATH="${HOME:-}/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -n "${HOME:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  latest_nvm_node=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1) || true
  if [ -n "$latest_nvm_node" ]; then
    export PATH="$latest_nvm_node:$PATH"
  fi
fi
