defmodule Localfinds.Agents.SpawnerTest do
  use ExUnit.Case, async: false

  alias Localfinds.Agents.Spawner

  describe "impl/0" do
    test "defaults to the System implementation" do
      previous = Application.get_env(:localfinds, :agent_spawner)
      Application.delete_env(:localfinds, :agent_spawner)

      on_exit(fn ->
        if previous, do: Application.put_env(:localfinds, :agent_spawner, previous)
      end)

      assert Spawner.impl() == Localfinds.Agents.Spawner.System
    end

    test "config/test.exs points it at the stub, so the suite never spawns a real CLI" do
      assert Spawner.impl() == Localfinds.Agents.SpawnerStub
    end
  end

  describe "run/1" do
    test "delegates to the configured implementation" do
      Application.put_env(:localfinds, :spawner_test_pid, self())
      on_exit(fn -> Application.delete_env(:localfinds, :spawner_test_pid) end)

      assert Spawner.run("scout") == :ok
      assert_received {:spawned, "scout"}
    end
  end

  describe "System.command/1" do
    test "runs the agent CLI for the target, detached, with output redirected" do
      cmd = Spawner.System.command("scout")

      assert cmd =~ "npx tsx packages/agents/src/cli.ts scout"
      assert cmd =~ "data/agents/web.log"
      # Backgrounded, so the wrapper shell exits and System.cmd returns
      # immediately instead of blocking on the agent run.
      assert String.ends_with?(String.trim(cmd), "&")
    end

    test "writes the ops banner to the log, not to the page" do
      assert Spawner.System.command("all") =~ "=== web-trigger all"
    end
  end

  describe "System.env/0" do
    test "unsets the read-only DSN rather than blanking it" do
      # nil is the unset (System.cmd/3's own documented mechanism for keeping
      # credentials out of a child process). "" would leave the variable set
      # to an empty string, which is still a *set* variable.
      assert {"LOCALFINDS_DATABASE_URL", nil} in Spawner.System.env()
    end
  end
end
