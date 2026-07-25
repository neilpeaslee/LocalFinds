defmodule Localfinds.AgentNotesTest do
  use ExUnit.Case, async: false

  alias Localfinds.AgentNotes

  setup do
    dir = Path.join(System.tmp_dir!(), "agent_notes_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join([dir, "agents", "source-keeper", "notes"]))
    File.write!(Path.join([dir, "agents", "source-keeper", "notes", "site.md"]), "# Site note\n")
    File.write!(Path.join(dir, "secret.md"), "not for the web\n")

    previous = Application.get_env(:localfinds, :data_dir)
    Application.put_env(:localfinds, :data_dir, dir)

    on_exit(fn ->
      Application.put_env(:localfinds, :data_dir, previous)
      File.rm_rf!(dir)
    end)

    :ok
  end

  test "reads a workspace-relative note" do
    assert AgentNotes.read("source-keeper", "notes/site.md") == "# Site note\n"
  end

  test "nil, blank, and missing notes paths return nil" do
    assert AgentNotes.read("source-keeper", nil) == nil
    assert AgentNotes.read("source-keeper", "") == nil
    assert AgentNotes.read("source-keeper", "notes/absent.md") == nil
  end

  test "refuses to escape the agent workspace" do
    assert AgentNotes.read("source-keeper", "../../secret.md") == nil
    assert AgentNotes.read("source-keeper", "/etc/passwd") == nil
  end

  test "refuses a sibling agent's workspace via a prefix trick" do
    assert AgentNotes.read("source-keeper", "../source-keeper-evil/note.md") == nil
  end
end
