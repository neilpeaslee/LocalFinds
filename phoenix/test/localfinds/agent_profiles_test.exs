defmodule Localfinds.AgentProfilesTest do
  # async: false, not the brief's async: true — this setup mutates the global
  # :localfinds, :data_dir application env for the duration of each test, the
  # same shared mutable state Localfinds.AgentNotesTest (async: false) and
  # SourcesLive.ShowTest (async: false) touch. Localfinds.DataDirTest is
  # async: true, but it only ever reads DataDir.path/0 against the env test.exs
  # already sets — it never calls Application.put_env/3. Running this module
  # async risked an intermittent DataDirTest failure if the two ran
  # concurrently and this module's setup happened to be the one holding the
  # env when DataDirTest asserted the fixtures path.
  use ExUnit.Case, async: false

  alias Localfinds.AgentProfiles

  setup do
    dir = Path.join(System.tmp_dir!(), "agent-profiles-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join([dir, "data", "config"]))
    File.mkdir_p!(Path.join([dir, "data", "agents", "scout"]))

    File.write!(
      Path.join([dir, "data", "agents", "scout", "profile.md"]),
      "# Scout\n\nlikes markets"
    )

    File.write!(Path.join([dir, "data", "secrets.md"]), "not yours")

    previous = Application.get_env(:localfinds, :data_dir)
    Application.put_env(:localfinds, :data_dir, Path.join(dir, "data"))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:localfinds, :data_dir, previous),
        else: Application.delete_env(:localfinds, :data_dir)

      File.rm_rf!(dir)
    end)

    :ok
  end

  test "reads an agent's profile" do
    assert AgentProfiles.read("scout") =~ "likes markets"
  end

  test "returns nil when the agent has no profile yet" do
    assert AgentProfiles.read("curator") == nil
  end

  test "refuses a name that escapes the agents directory" do
    assert AgentProfiles.read("../secrets") == nil
    assert AgentProfiles.read("../../etc/passwd") == nil
    assert AgentProfiles.read("scout/../../secrets") == nil
  end

  test "refuses names outside the allowed character set" do
    assert AgentProfiles.read("Scout") == nil
    assert AgentProfiles.read("scout profile") == nil
    assert AgentProfiles.read("") == nil
  end

  # Beyond the brief's cases: adversarial inputs chosen to probe the whitelist
  # and the containment guard independently, and to prove neither one crashes
  # the LiveView process instead of degrading to nil — a run row's `agent`
  # is a DB value on a steward-gated page, but a compromised writer or a
  # future non-CLI writer to localfinds.runs is exactly the threat this guard
  # exists for.
  test "refuses an absolute path used as the agent name" do
    assert AgentProfiles.read("/etc/passwd") == nil
  end

  test "refuses a name that is only traversal segments" do
    assert AgentProfiles.read("..") == nil
    assert AgentProfiles.read("../..") == nil
  end

  test "refuses a name containing a null byte instead of raising" do
    assert AgentProfiles.read("scout\0/../../secrets") == nil
  end

  test "refuses a non-string agent value instead of raising" do
    assert AgentProfiles.read(nil) == nil
    assert AgentProfiles.read(123) == nil
  end
end
