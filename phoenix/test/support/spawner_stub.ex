defmodule Localfinds.Agents.SpawnerStub do
  @moduledoc """
  Test double for `Localfinds.Agents.Spawner`. The suite must never shell out
  to the real agent CLI: a real run spends money against a live API key and
  writes to the production database. `config/test.exs` points
  `:agent_spawner` here.

  Messages the pid in `:spawner_test_pid` (if any) so a test can assert what
  was requested, and returns whatever `:spawner_result` says (defaulting to
  `:ok`) so the error path is exercisable too.
  """
  @behaviour Localfinds.Agents.Spawner

  @impl true
  def run(target) do
    if pid = Application.get_env(:localfinds, :spawner_test_pid) do
      send(pid, {:spawned, target})
    end

    Application.get_env(:localfinds, :spawner_result, :ok)
  end
end
