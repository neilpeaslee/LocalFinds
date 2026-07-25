defmodule LocalfindsWeb.PlaceRanking do
  @moduledoc """
  Search-priority ranking, visibility rules and column sorting for the /places
  directory — port of `packages/db/src/place-sort.ts` plus the annotate/filter
  half of `listPlacesRanked`.

  The default (no explicit sort) ordering is chains last, then tier, then name;
  it is the shared "what matters locally" ranking, so it must not drift. An
  explicit column sort overrides it, always sorts nulls last regardless of
  direction, and breaks ties by name without flipping that tiebreak.
  """

  alias Localfinds.Categories
  alias Localfinds.Places.DirectoryPlace

  @sort_keys ~w(tier name kind town)

  @type ranked :: %{place: DirectoryPlace.t(), tier: integer(), is_chain: boolean()}

  @spec parse_sort(String.t() | nil) :: :tier | :name | :kind | :town | nil
  def parse_sort(raw) when raw in @sort_keys, do: String.to_existing_atom(raw)
  def parse_sort(_), do: nil

  @spec parse_dir(String.t() | nil) :: :asc | :desc
  def parse_dir("desc"), do: :desc
  def parse_dir(_), do: :asc

  @spec annotate([DirectoryPlace.t()], Categories.t()) :: [ranked()]
  def annotate(places, %Categories{} = cfg) do
    Enum.map(places, fn place ->
      %{place: place, tier: Categories.tier_of(cfg, place.kind), is_chain: chain?(place)}
    end)
  end

  @spec counts([ranked()]) :: %{tier4: integer(), chain: integer()}
  def counts(rows) do
    Enum.reduce(rows, %{tier4: 0, chain: 0}, fn row, acc ->
      acc = if row.tier == 4, do: %{acc | tier4: acc.tier4 + 1}, else: acc
      if row.is_chain, do: %{acc | chain: acc.chain + 1}, else: acc
    end)
  end

  @spec visible([ranked()], boolean(), boolean()) :: [ranked()]
  def visible(rows, show_tier4?, show_chains?) do
    Enum.filter(rows, fn row ->
      (show_tier4? or row.tier != 4) and (show_chains? or not row.is_chain)
    end)
  end

  @spec sort([ranked()], atom() | nil, :asc | :desc) :: [ranked()]
  def sort(rows, nil, _dir), do: Enum.sort(rows, &(rank_compare(&1, &2) != :gt))

  def sort(rows, key, dir) do
    factor = if dir == :asc, do: 1, else: -1
    Enum.sort(rows, &(column_compare(&1, &2, key, factor) != :gt))
  end

  # An OSM brand tag means a national/regional chain. "" is not a brand (the TS
  # side reads it through Boolean(), where "" is falsy).
  defp chain?(%DirectoryPlace{brand: brand}), do: is_binary(brand) and brand != ""

  defp rank_compare(a, b) do
    cond do
      a.is_chain != b.is_chain -> if a.is_chain, do: :gt, else: :lt
      a.tier != b.tier -> if a.tier < b.tier, do: :lt, else: :gt
      true -> collate(a.place.name, b.place.name)
    end
  end

  defp column_compare(a, b, key, factor) do
    av = value_of(a, key)
    bv = value_of(b, key)

    cond do
      is_nil(av) and is_nil(bv) -> :eq
      is_nil(av) -> :gt
      is_nil(bv) -> :lt
      true -> compare_present(a, b, av, bv, factor)
    end
  end

  defp compare_present(a, b, av, bv, factor) do
    case raw_compare(av, bv) do
      :eq -> collate(a.place.name, b.place.name)
      cmp -> apply_dir(cmp, factor)
    end
  end

  defp raw_compare(av, bv) when is_integer(av) and is_integer(bv) do
    cond do
      av < bv -> :lt
      av > bv -> :gt
      true -> :eq
    end
  end

  defp raw_compare(av, bv), do: collate(to_string(av), to_string(bv))

  defp apply_dir(cmp, 1), do: cmp
  defp apply_dir(:lt, _), do: :gt
  defp apply_dir(:gt, _), do: :lt
  defp apply_dir(:eq, _), do: :eq

  defp value_of(row, :tier), do: row.tier
  defp value_of(row, :name), do: row.place.name
  defp value_of(row, :kind), do: row.place.kind
  defp value_of(row, :town), do: row.place.town

  # Approximates JS localeCompare well enough for a directory: case-insensitive
  # first, then the raw string as a deterministic tiebreak.
  defp collate(a, b) do
    x = {String.downcase(a), a}
    y = {String.downcase(b), b}

    cond do
      x < y -> :lt
      x > y -> :gt
      true -> :eq
    end
  end
end
