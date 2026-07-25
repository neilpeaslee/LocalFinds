defmodule Localfinds.DataDir do
  @moduledoc """
  Resolves the LocalFinds `data/` directory — the Elixir counterpart of
  `packages/db/src/paths.ts`.

  Resolution order:

    1. `config :localfinds, :data_dir` — set in `config/test.exs` so tests read
       committed fixtures instead of the developer's gitignored `data/`.
    2. `LOCALFINDS_DATA_DIR` — the ops override (same variable the TS side uses).
    3. An upward walk for a directory containing `data/config`, starting from the
       app's `priv/` dir and then the cwd. This finds the repo root in dev
       (`phoenix/_build/<env>/lib/localfinds/priv` -> repo root) and the deploy
       checkout in prod (the release lives under `$DEPLOY_PATH/phoenix/_build/...`
       and systemd sets `WorkingDirectory=$DEPLOY_PATH/phoenix`, so both starting
       points reach `$DEPLOY_PATH`, which holds the rsynced `data/config`).

  Returns nil when nothing resolves; every caller degrades to a sane default
  rather than crashing a page.
  """

  @spec path() :: String.t() | nil
  def path do
    Application.get_env(:localfinds, :data_dir) ||
      System.get_env("LOCALFINDS_DATA_DIR") ||
      Enum.find_value(start_dirs(), &find_from/1)
  end

  @spec find_from(String.t()) :: String.t() | nil
  def find_from(dir) do
    candidate = Path.join(dir, "data")

    cond do
      File.dir?(Path.join(candidate, "config")) ->
        candidate

      true ->
        parent = Path.dirname(dir)
        if parent == dir, do: nil, else: find_from(parent)
    end
  end

  @spec config_file(String.t()) :: String.t() | nil
  def config_file(name) do
    case path() do
      nil -> nil
      dir -> Path.join([dir, "config", name])
    end
  end

  @spec agent_workspace(String.t()) :: String.t() | nil
  def agent_workspace(agent) do
    case path() do
      nil -> nil
      dir -> Path.join([dir, "agents", agent])
    end
  end

  defp start_dirs do
    priv =
      case :code.priv_dir(:localfinds) do
        {:error, _} -> nil
        dir -> to_string(dir)
      end

    cwd = File.cwd!()

    Enum.reject([priv, cwd], &is_nil/1)
  end
end
