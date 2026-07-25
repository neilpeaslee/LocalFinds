defmodule Localfinds.Categories do
  @moduledoc """
  Search-priority tiers from `data/config/categories.json` — port of
  `readCategoryConfig()` in `packages/db/src/config.ts`.

  Candidate order is the same: the real file, then the committed `.example`
  template, then a permissive default (everything at `default_tier`), so a
  missing or hand-broken file never takes the directory down. Values are coerced
  defensively — a non-numeric `default_tier` or tier key is ignored, not NaN.
  """

  alias Localfinds.DataDir

  defstruct default_tier: 3, hide_tier4: true, hide_chains: true, exact: %{}, wild: %{}

  @type t :: %__MODULE__{
          default_tier: integer(),
          hide_tier4: boolean(),
          hide_chains: boolean(),
          exact: %{String.t() => integer()},
          wild: %{String.t() => integer()}
        }

  @spec load() :: t()
  def load, do: load(DataDir.path())

  @spec load(String.t() | nil) :: t()
  def load(nil), do: %__MODULE__{}

  def load(dir) do
    file = Path.join([dir, "config", "categories.json"])

    [file, file <> ".example"]
    |> Enum.find_value(%{}, &read_json/1)
    |> build()
  end

  @spec tier_of(t(), String.t() | nil) :: integer()
  def tier_of(%__MODULE__{} = cfg, kind) when kind in [nil, ""], do: cfg.default_tier

  def tier_of(%__MODULE__{} = cfg, kind) do
    case Map.fetch(cfg.exact, kind) do
      {:ok, tier} ->
        tier

      :error ->
        key = kind |> String.split("=", parts: 2) |> hd()
        Map.get(cfg.wild, key, cfg.default_tier)
    end
  end

  defp read_json(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, json} when is_map(json) <- Jason.decode(raw) do
      json
    else
      _ -> nil
    end
  end

  defp build(json) do
    hide = Map.get(json, "hide_in_directory", %{})
    hide = if is_map(hide), do: hide, else: %{}
    {exact, wild} = index_tiers(Map.get(json, "tiers", %{}))

    %__MODULE__{
      default_tier: to_tier(Map.get(json, "default_tier"), 3),
      hide_tier4: Map.get(hide, "tier4", true) == true,
      hide_chains: Map.get(hide, "chains", true) == true,
      exact: exact,
      wild: wild
    }
  end

  defp index_tiers(tiers) when is_map(tiers) do
    Enum.reduce(tiers, {%{}, %{}}, fn {tier_str, cats}, {exact, wild} ->
      case {to_tier(tier_str, nil), cats} do
        {nil, _} ->
          {exact, wild}

        {tier, cats} when is_list(cats) ->
          Enum.reduce(cats, {exact, wild}, fn
            cat, {ex, wi} when is_binary(cat) ->
              if String.ends_with?(cat, "=*") do
                {ex, Map.put(wi, String.replace_suffix(cat, "=*", ""), tier)}
              else
                {Map.put(ex, cat, tier), wi}
              end

            _cat, acc ->
              acc
          end)

        _ ->
          {exact, wild}
      end
    end)
  end

  defp index_tiers(_), do: {%{}, %{}}

  defp to_tier(value, _fallback) when is_integer(value), do: value
  defp to_tier(value, _fallback) when is_float(value), do: trunc(value)

  defp to_tier(value, fallback) when is_binary(value) do
    case Integer.parse(value) do
      {n, ""} -> n
      _ -> fallback
    end
  end

  defp to_tier(_value, fallback), do: fallback
end
