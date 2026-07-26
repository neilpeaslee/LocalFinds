defmodule Localfinds.Agents.Spawner.System do
  @moduledoc """
  Spawns the detached agent CLI - port of `triggerRun` in
  apps/web/src/app/agents/actions.ts (env stripping via
  apps/web/src/lib/agent-spawn-env.ts).

  Three details are load-bearing:

    * The child's `LOCALFINDS_DATABASE_URL` is unset via `{"...", nil}` in
      `env/0`, not blanked to `""`. Phoenix runs with the read-only DSN; the
      CLI's own `loadEnv()` leaves an already-set variable alone, so an
      inherited read-only DSN would silently win over the write DSN in the
      box `.env` and every agent write would fail. `nil` is `System.cmd/3`'s
      own documented mechanism for exactly this: "Specify a value of nil to
      clear (unset) an environment variable, which is useful for preventing
      credentials passed to the application from leaking into child
      processes." (The TS reference instead `delete`s the key from a plain
      object - its own env stand-in - for the same reason: Node's
      child_process would otherwise pass an empty-but-present var straight
      through.)

    * `script/0` redirects both the eventual CLI's stdout and stderr into
      `data/agents/web.log` before backgrounding it with `setsid nohup ...
      &`. `System.cmd/3` only returns once the port's stdout is closed; a
      backgrounded child that inherited the port's stdout would keep that
      pipe open for as long as it runs (see the "Zombie processes" section of
      the `Port` docs), hanging the calling LiveView. Redirecting to a file
      first means the child never holds the pipe, so the wrapper shell - and
      the `System.cmd/3` call - returns as soon as it has fired off the
      background job, well before the agent finishes.

    * `target` is never spliced into the script text. It rides as the shell's
      `$1` instead: `args/1` passes the constant `script/0` string to
      `/bin/sh -c` followed by `"spawner"` and `target` as trailing argv,
      which `sh` binds to `$0` and `$1`. Positional parameters are not
      re-scanned for `$()`/backtick command substitution, so a hostile target
      like `"$(rm -rf /)"` comes out inert - it is data, not source, to the
      shell. `Runs.resolve_target/1`'s fixed allowlist (the caller's job, not
      this module's) is a second, independent line of defense; the escaping
      here does not depend on it.
  """
  @behaviour Localfinds.Agents.Spawner

  alias Localfinds.DataDir

  @log_path "data/agents/web.log"

  @impl true
  @spec run(String.t()) :: :ok | {:error, term()}
  def run(target) do
    case repo_root() do
      nil ->
        {:error, :no_data_dir}

      root ->
        case System.cmd("/bin/sh", args(target), cd: root, env: env(), stderr_to_stdout: true) do
          {_out, 0} -> :ok
          {out, code} -> {:error, {code, out}}
        end
    end
  end

  @doc """
  The full argv for `System.cmd("/bin/sh", args(target), ...)`: `-c`, the
  constant script, then `$0` (`"spawner"`, a conventional placeholder name)
  and `target` as `$1`. `target` is passed as a single argv element, never
  concatenated into the script string - see the moduledoc for why that is
  what keeps shell metacharacters in `target` inert.
  """
  @spec args(String.t()) :: [String.t()]
  def args(target), do: ["-c", script(), "spawner", target]

  @doc """
  The shell script, constant for every call - it references the target as
  `$1` rather than interpolating it. Exposed so tests can assert its shape
  without spawning anything.
  """
  @spec script() :: String.t()
  def script do
    """
    mkdir -p "$(dirname #{@log_path})"
    printf '\\n%s\\n' "=== web-trigger $1 $(date -Iseconds) ===" >> #{@log_path}
    setsid nohup npx tsx packages/agents/src/cli.ts "$1" >> #{@log_path} 2>&1 &
    """
  end

  @doc "Child environment overrides: everything Phoenix has, minus the read-only DSN."
  @spec env() :: [{String.t(), nil}]
  def env, do: [{"LOCALFINDS_DATABASE_URL", nil}]

  defp repo_root do
    case DataDir.path() do
      nil -> nil
      data_dir -> Path.dirname(data_dir)
    end
  end
end
