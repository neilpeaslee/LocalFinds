defmodule Localfinds.AgentNotes do
  @moduledoc """
  Reads a workspace-relative note for an agent, refusing any path that escapes
  that agent's workspace. Port of `readAgentNote()` in
  `packages/db/src/paths.ts` — the same single-place traversal guard, because
  `notes_path` is agent-written data, not a trusted constant.
  """

  alias Localfinds.DataDir

  @spec read(String.t(), String.t() | nil) :: String.t() | nil
  def read(_agent, nil), do: nil
  def read(_agent, ""), do: nil

  def read(agent, notes_path) when is_binary(notes_path) do
    with workspace when is_binary(workspace) <- DataDir.agent_workspace(agent),
         resolved = Path.expand(notes_path, workspace),
         true <- inside?(workspace, resolved),
         {:ok, body} <- File.read(resolved) do
      body
    else
      _ -> nil
    end
  end

  # Compare against `workspace <> "/"` so a sibling directory whose name merely
  # starts with the workspace name ("source-keeper-evil") is not accepted.
  defp inside?(workspace, resolved) do
    resolved == workspace or String.starts_with?(resolved, workspace <> "/")
  end
end
