defmodule Localfinds.MapCategories do
  @moduledoc """
  Map display themes from `data/config/map-categories.json` — port of
  `readMapCategories()` in `packages/db/src/config.ts`.

  Colors and groups OSM `kind`s into themes for the region map's pins and
  legend. Render-time only, like `Localfinds.Categories` tiers — deliberately
  not a schema column, honoring "no content taxonomy in the DB".

  Same candidate order as every other config reader: the real file, then the
  committed `.example`, then a permissive default where everything resolves to
  Other. A present-but-malformed file falls *through* to the next candidate
  rather than being accepted.

  Note that on a stock checkout there is no `map-categories.json` at all — only
  the `.example` — so the fallback chain is the live path, not a safety net.
  """

  alias Localfinds.DataDir

  defstruct themes: [],
            other_key: "other",
            other_label: "Other",
            other_color: "#64748b",
            exact: %{},
            wild: %{}

  @type theme :: %{key: String.t(), label: String.t(), color: String.t(), subtypes: map()}
  @type match :: %{
          key: String.t(),
          label: String.t(),
          color: String.t(),
          subtype: String.t() | nil,
          subtype_key: String.t() | nil
        }
  @type t :: %__MODULE__{
          themes: [theme()],
          other_key: String.t(),
          other_label: String.t(),
          other_color: String.t(),
          exact: %{String.t() => {theme(), String.t()}},
          wild: %{String.t() => {theme(), String.t()}}
        }

  @spec load() :: t()
  def load, do: load(DataDir.path())

  @spec load(String.t() | nil) :: t()
  def load(nil), do: %__MODULE__{}

  def load(dir) do
    file = Path.join([dir, "config", "map-categories.json"])

    [file, file <> ".example"]
    |> Enum.find_value(%{}, &read_json/1)
    |> build()
  end

  @spec theme_of(t(), String.t() | nil) :: match()
  def theme_of(%__MODULE__{} = cfg, kind) when kind in [nil, ""], do: other(cfg)

  def theme_of(%__MODULE__{} = cfg, kind) do
    case Map.fetch(cfg.exact, kind) do
      {:ok, {theme, label}} ->
        matched(theme, label, kind)

      :error ->
        key = kind |> String.split("=", parts: 2) |> hd()

        case Map.fetch(cfg.wild, key) do
          {:ok, {theme, label}} -> matched(theme, label, key <> "=*")
          :error -> other(cfg)
        end
    end
  end

  @doc """
  The legend rows: every theme plus the Other entry. `page.tsx` builds this
  inline when it constructs `mapThemes`; it lives here so the LiveView and its
  tests agree on the order.
  """
  @spec legend_themes(t()) :: [%{key: String.t(), label: String.t(), color: String.t()}]
  def legend_themes(%__MODULE__{} = cfg) do
    Enum.map(cfg.themes, &Map.take(&1, [:key, :label, :color])) ++
      [%{key: cfg.other_key, label: cfg.other_label, color: cfg.other_color}]
  end

  defp matched(theme, label, subtype_key) do
    %{
      key: theme.key,
      label: theme.label,
      color: theme.color,
      subtype: label,
      subtype_key: subtype_key
    }
  end

  defp other(cfg) do
    %{
      key: cfg.other_key,
      label: cfg.other_label,
      color: cfg.other_color,
      subtype: nil,
      subtype_key: nil
    }
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
    themes = json |> Map.get("themes") |> normalize_themes()
    {exact, wild} = index(themes)

    %__MODULE__{
      themes: themes,
      other_key: to_str(Map.get(json, "otherKey"), "other"),
      other_label: to_str(Map.get(json, "otherLabel"), "Other"),
      other_color: to_str(Map.get(json, "otherColor"), "#64748b"),
      exact: exact,
      wild: wild
    }
  end

  defp normalize_themes(themes) when is_list(themes) do
    for t <- themes, is_map(t), is_binary(t["key"]) do
      %{
        key: t["key"],
        label: to_str(t["label"], t["key"]),
        color: to_str(t["color"], "#64748b"),
        subtypes: if(is_map(t["subtypes"]), do: t["subtypes"], else: %{})
      }
    end
  end

  defp normalize_themes(_), do: []

  # First theme listed wins a duplicate key — Map.put_new, matching the TS
  # readers' `if (!exact.has(k))` guard.
  defp index(themes) do
    Enum.reduce(themes, {%{}, %{}}, fn theme, acc ->
      Enum.reduce(theme.subtypes, acc, fn
        {k, label}, {exact, wild} when is_binary(k) and is_binary(label) ->
          if String.ends_with?(k, "=*") do
            {exact, Map.put_new(wild, String.replace_suffix(k, "=*", ""), {theme, label})}
          else
            {Map.put_new(exact, k, {theme, label}), wild}
          end

        _pair, acc ->
          acc
      end)
    end)
  end

  defp to_str(value, _fallback) when is_binary(value), do: value
  defp to_str(_value, fallback), do: fallback
end
