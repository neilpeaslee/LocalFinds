defmodule Localfinds.Agents.Spawner.System do
  @moduledoc """
  Spawns the detached agent CLI - port of `triggerRun` in
  apps/web/src/app/agents/actions.ts (env stripping via
  apps/web/src/lib/agent-spawn-env.ts).

  Two details are load-bearing:

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

    * `command/1` redirects both the eventual CLI's stdout and stderr into
      `data/agents/web.log` before backgrounding it with `setsid nohup ...
      &`. `System.cmd/3` only returns once the port's stdout is closed; a
      backgrounded child that inherited the port's stdout would keep that
      pipe open for as long as it runs (see the "Zombie processes" section of
      the `Port` docs), hanging the calling LiveView. Redirecting to a file
      first means the child never holds the pipe, so the wrapper shell - and
      the `System.cmd/3` call - returns as soon as it has fired off the
      background job, well before the agent finishes.
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
        case System.cmd("/bin/sh", ["-c", command(target)],
               cd: root,
               env: env(),
               stderr_to_stdout: true
             ) do
          {_out, 0} -> :ok
          {out, code} -> {:error, {code, out}}
        end
    end
  end

  @doc """
  The shell command that logs a banner and fires off the detached CLI.
  Exposed so tests can assert the exact invocation without spawning it.
  """
  @spec command(String.t()) :: String.t()
  def command(target) do
    banner = "=== web-trigger #{target} $(date -Iseconds) ==="

    """
    mkdir -p "$(dirname #{@log_path})"
    printf '\\n%s\\n' "#{banner}" >> #{@log_path}
    setsid nohup npx tsx packages/agents/src/cli.ts #{target} >> #{@log_path} 2>&1 &
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
