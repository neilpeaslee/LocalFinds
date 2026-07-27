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
      # Pinned locally rather than trusting config/test.exs's global setting:
      # if that config line were ever lost, impl/0 would fall back to the
      # real Spawner.System, and this test - the only one that goes through
      # run/1's dynamic dispatch - would shell out for real. Pinning here
      # means this test stays safe even if the global wiring regresses (the
      # "config/test.exs points it at the stub" test above is what watches
      # for that regression).
      previous = Application.get_env(:localfinds, :agent_spawner)
      Application.put_env(:localfinds, :agent_spawner, Localfinds.Agents.SpawnerStub)
      Application.put_env(:localfinds, :spawner_test_pid, self())

      on_exit(fn ->
        Application.delete_env(:localfinds, :spawner_test_pid)

        if previous do
          Application.put_env(:localfinds, :agent_spawner, previous)
        else
          Application.delete_env(:localfinds, :agent_spawner)
        end
      end)

      assert Spawner.run("scout") == :ok
      assert_received {:spawned, "scout"}
    end
  end

  describe "System.args/1" do
    test "builds argv for /bin/sh -c: the constant script, then $0 and the target as $1" do
      assert Spawner.System.args("scout") == ["-c", Spawner.System.script(), "spawner", "scout"]
    end

    test "passes a hostile target through as a single literal argv element, never spliced into the script" do
      malicious = "$(echo INJECTED)"

      args = Spawner.System.args(malicious)

      assert List.last(args) == malicious
      # The script itself is constant across targets - the value never lands
      # inside the script text, only in argv, where sh binds it to $1.
      script = Spawner.System.script()
      refute script =~ "INJECTED"
      refute script =~ malicious
      assert script =~ ~s("$1")
    end
  end

  describe "System.script/0" do
    test "invokes the agent CLI with the target as $1, detached, with output redirected" do
      script = Spawner.System.script()

      assert script =~ ~s(npx tsx packages/agents/src/cli.ts "$1")
      assert script =~ "data/agents/web.log"
      # Backgrounded, so the wrapper shell exits and System.cmd returns
      # immediately instead of blocking on the agent run.
      assert String.ends_with?(String.trim(script), "&")
    end

    test "writes the ops banner (with the target as $1) to the log, not to the page" do
      assert Spawner.System.script() =~ "=== web-trigger $1"
    end
  end

  describe "shell metacharacters in a target are inert at runtime" do
    test "command substitution in the target does not execute" do
      # Reproduces the exact injection class a reviewer found against an
      # earlier version of this module (target spliced straight into the
      # script string, so `$(...)` in it ran). Proves the fix - target rides
      # in as sh's $1, a positional parameter, which is not re-scanned for
      # command substitution - by actually running a shell invocation built
      # the same way (constant script text + target as trailing argv).
      #
      # The real script/0 hardcodes the actual "npx tsx ..." CLI invocation,
      # so this test does not run System.args/1's output as-is (that would
      # shell out to the real agent CLI, which costs money and writes to the
      # production database). Instead it swaps in `printf`, an inert stand-in
      # for the payload, while keeping the identical $1-based defense.
      marker =
        Path.join(
          System.tmp_dir!(),
          "spawner_injection_test_#{System.unique_integer([:positive])}"
        )

      on_exit(fn -> File.rm(marker) end)

      malicious = "$(touch #{marker})"
      inert_script = ~s(printf '%s' "$1")

      {out, 0} = System.cmd("/bin/sh", ["-c", inert_script, "spawner", malicious])

      assert out == malicious
      refute File.exists?(marker)
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
