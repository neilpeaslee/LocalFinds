defmodule Localfinds.Agents.Spawner do
  @moduledoc """
  Starts an agent run. Behind a behaviour so tests assert what would be
  spawned without actually launching a Node process — a real run costs money
  against a live API key and writes to the production database.

  `impl/0` is config-driven: `config/test.exs` points it at
  `Localfinds.Agents.SpawnerStub`, dev and prod fall through to the default,
  `Localfinds.Agents.Spawner.System`.
  """

  @callback run(target :: String.t()) :: :ok | {:error, term()}

  @spec impl() :: module()
  def impl do
    Application.get_env(:localfinds, :agent_spawner, Localfinds.Agents.Spawner.System)
  end

  @spec run(String.t()) :: :ok | {:error, term()}
  def run(target), do: impl().run(target)
end
