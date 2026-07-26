defmodule Localfinds.AgentProfiles do
  @moduledoc """
  Reads an agent's `profile.md` — the hand-editable interest profile the console
  renders. Port of `readProfile()` in apps/web/src/app/agents/page.tsx.

  Agent names now arrive from `runs.agent`, a database value, so this is a
  DB-sourced string reaching a filesystem path. Two guards, in order: a name
  whitelist, then the same resolve-and-contain check Localfinds.AgentNotes uses.
  Either guard alone would stop every traversal attempt tried here (the
  whitelist forbids "/" and "." outright, so a workspace built from a
  whitelisted name can never expand outside `data/agents/`), but the second
  guard stays as a backstop against a future change to the whitelist or to
  DataDir.agent_workspace/1 that a reviewer might not connect back to this
  module.
  """

  alias Localfinds.DataDir

  @name ~r/\A[a-z0-9-]+\z/

  @spec read(String.t()) :: String.t() | nil
  def read(agent) when is_binary(agent) do
    with true <- Regex.match?(@name, agent),
         workspace when is_binary(workspace) <- DataDir.agent_workspace(agent),
         resolved = Path.expand("profile.md", workspace),
         true <- inside?(workspace, resolved),
         {:ok, body} <- File.read(resolved) do
      body
    else
      _ -> nil
    end
  end

  def read(_), do: nil

  # Compare against `workspace <> "/"` so a sibling directory whose name merely
  # starts with the workspace name is not accepted.
  defp inside?(workspace, resolved) do
    String.starts_with?(resolved, workspace <> "/")
  end
end
