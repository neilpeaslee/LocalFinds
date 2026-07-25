defmodule LocalfindsWeb.PlaceRankingTest do
  use ExUnit.Case, async: true

  alias Localfinds.Categories
  alias Localfinds.Places.DirectoryPlace
  alias LocalfindsWeb.PlaceRanking, as: Ranking

  defp place(attrs), do: struct(%DirectoryPlace{osm_id: "node/0", name: "X"}, attrs)

  defp ranked(name, tier, is_chain, extra \\ []) do
    %{place: place([{:name, name} | extra]), tier: tier, is_chain: is_chain}
  end

  test "parse_sort/1 accepts the four columns and defaults to nil (the ranking)" do
    assert Ranking.parse_sort("tier") == :tier
    assert Ranking.parse_sort("name") == :name
    assert Ranking.parse_sort("kind") == :kind
    assert Ranking.parse_sort("town") == :town
    assert Ranking.parse_sort("bogus") == nil
    assert Ranking.parse_sort(nil) == nil
  end

  test "parse_dir/1 defaults to asc" do
    assert Ranking.parse_dir("desc") == :desc
    assert Ranking.parse_dir("asc") == :asc
    assert Ranking.parse_dir(nil) == :asc
    assert Ranking.parse_dir("sideways") == :asc
  end

  test "annotate/2 attaches the tier and the chain flag" do
    cfg = Categories.load()

    rows =
      Ranking.annotate(
        [
          place(name: "Museum", kind: "tourism=museum"),
          place(name: "Chain", kind: "amenity=cafe", brand: "Big Co"),
          place(name: "Blank brand", kind: "amenity=cafe", brand: "")
        ],
        cfg
      )

    assert Enum.map(rows, & &1.tier) == [1, 3, 3]
    assert Enum.map(rows, & &1.is_chain) == [false, true, false]
  end

  test "counts/1 counts tier-4 rows and chains" do
    rows = [ranked("a", 4, false), ranked("b", 1, true), ranked("c", 4, true)]
    assert Ranking.counts(rows) == %{tier4: 2, chain: 2}
  end

  test "visible/3 applies the two hide rules independently" do
    rows = [ranked("plain", 1, false), ranked("t4", 4, false), ranked("chain", 1, true)]

    assert Enum.map(Ranking.visible(rows, false, false), & &1.place.name) == ["plain"]
    assert Enum.map(Ranking.visible(rows, true, false), & &1.place.name) == ["plain", "t4"]
    assert Enum.map(Ranking.visible(rows, false, true), & &1.place.name) == ["plain", "chain"]
    assert length(Ranking.visible(rows, true, true)) == 3
  end

  test "the default ranking is chains last, then tier, then name" do
    rows = [
      ranked("Zebra", 1, false),
      ranked("Alpha chain", 1, true),
      ranked("Beta", 2, false),
      ranked("Apple", 1, false)
    ]

    assert Enum.map(Ranking.sort(rows, nil, :asc), & &1.place.name) ==
             ["Apple", "Zebra", "Beta", "Alpha chain"]
  end

  test "an explicit sort ignores the chain rule and honours direction" do
    rows = [ranked("Beta", 1, false), ranked("Alpha", 2, true)]

    assert Enum.map(Ranking.sort(rows, :name, :asc), & &1.place.name) == ["Alpha", "Beta"]
    assert Enum.map(Ranking.sort(rows, :name, :desc), & &1.place.name) == ["Beta", "Alpha"]
    assert Enum.map(Ranking.sort(rows, :tier, :asc), & &1.place.name) == ["Beta", "Alpha"]
    assert Enum.map(Ranking.sort(rows, :tier, :desc), & &1.place.name) == ["Alpha", "Beta"]
  end

  test "nulls sort last in BOTH directions" do
    rows = [
      ranked("no kind", 1, false, kind: nil),
      ranked("has kind", 1, false, kind: "shop=books")
    ]

    assert Enum.map(Ranking.sort(rows, :kind, :asc), & &1.place.name) == ["has kind", "no kind"]
    assert Enum.map(Ranking.sort(rows, :kind, :desc), & &1.place.name) == ["has kind", "no kind"]
  end

  test "equal sort values fall back to a name tiebreak that ignores direction" do
    rows = [
      ranked("Zulu", 1, false, town: "Rockland"),
      ranked("Alpha", 1, false, town: "Rockland")
    ]

    assert Enum.map(Ranking.sort(rows, :town, :asc), & &1.place.name) == ["Alpha", "Zulu"]
    assert Enum.map(Ranking.sort(rows, :town, :desc), & &1.place.name) == ["Alpha", "Zulu"]
  end

  test "name ordering is case-insensitive first, like localeCompare" do
    rows = [ranked("banana", 1, false), ranked("Apple", 1, false), ranked("Cherry", 1, false)]

    assert Enum.map(Ranking.sort(rows, :name, :asc), & &1.place.name) ==
             ["Apple", "banana", "Cherry"]
  end
end
