defmodule Localfinds.Region do
  @moduledoc """
  Region display name from `data/config/region.md`. Port of `readRegionConfig()`
  in `packages/db/src/config.ts`: the name lives in the YAML frontmatter
  (`name: "Rockland, Maine"`), not in an H1. Surrounding quotes are stripped the
  same way the TS parser strips them.
  """

  alias Localfinds.DataDir

  @frontmatter ~r/\A---\n(?<fm>.*?)\n---/s
  @name_line ~r/^name:\s*(?<name>.+)$/m
  @unnamed "Unnamed region"

  @spec name() :: String.t() | nil
  def name, do: name(DataDir.path())

  @spec name(String.t() | nil) :: String.t() | nil
  def name(nil), do: nil

  def name(dir) do
    case File.read(Path.join([dir, "config", "region.md"])) do
      {:ok, raw} -> parse_name(raw)
      {:error, _} -> nil
    end
  end

  # Mirrors readRegionConfig() in packages/db/src/config.ts: a *readable* file
  # that lacks frontmatter or a `name:` key falls back to "Unnamed region"
  # (truthy — the Next reference still renders the badge). nil is reserved for
  # "no file at all". Do not simplify this back to nil.
  defp parse_name(raw) do
    with %{"fm" => fm} <- Regex.named_captures(@frontmatter, raw),
         %{"name" => name} <- Regex.named_captures(@name_line, fm) do
      name |> String.trim() |> String.replace(~r/^["']|["']$/, "")
    else
      _ -> @unnamed
    end
  end
end
