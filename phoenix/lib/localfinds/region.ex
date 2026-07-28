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

  # Distinct from @frontmatter: that one captures the block's *contents* for the
  # name; this one matches the whole delimited block, including its trailing
  # newline, so removing it leaves the body flush.
  @frontmatter_block ~r/\A---\n.*?\n---\n?/s
  # `im` matches the JS /^##\s+Seed sources/im — multiline so it anchors to a
  # heading at line start, case-insensitive so "## SEED SOURCES" also cuts.
  @seed_heading ~r/^##\s+Seed sources/im

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

  @doc """
  The human-facing coverage prose from `region.md` — port of `coverageProse()`
  in `apps/web/src/app/page.tsx`.

  Drops the YAML frontmatter and the `## Seed sources` section, which
  `region.md` keeps for the agents' prompts and which no visitor should see.
  Returns nil when there is no file, and *also* when the remaining prose is
  empty, so callers need only one `:if` guard — the reference's
  `region && coverageProse(region.raw)` is falsy for an empty string too.
  """
  @spec coverage() :: String.t() | nil
  def coverage, do: coverage(DataDir.path())

  @spec coverage(String.t() | nil) :: String.t() | nil
  def coverage(nil), do: nil

  def coverage(dir) do
    case File.read(Path.join([dir, "config", "region.md"])) do
      {:ok, raw} -> raw |> strip_frontmatter() |> cut_seed_sources() |> blank_to_nil()
      {:error, _} -> nil
    end
  end

  defp strip_frontmatter(raw), do: String.replace(raw, @frontmatter_block, "", global: false)

  defp cut_seed_sources(body) do
    case Regex.run(@seed_heading, body, return: :index) do
      [{start, _len} | _] -> binary_part(body, 0, start)
      nil -> body
    end
  end

  defp blank_to_nil(body) do
    case String.trim(body) do
      "" -> nil
      trimmed -> trimmed
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
