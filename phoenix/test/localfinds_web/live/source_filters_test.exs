defmodule LocalfindsWeb.SourceFiltersTest do
  use ExUnit.Case, async: true

  alias LocalfindsWeb.SourceFilters, as: F
  alias Localfinds.Sources.Source

  defp src(attrs), do: struct(%Source{status: "active", finds_count: 0}, attrs)

  test "parse_* fall back to defaults on garbage" do
    assert F.parse_sort("quality") == :quality
    assert F.parse_sort("bogus") == :name
    assert F.parse_dir("desc") == :desc
    assert F.parse_dir(nil) == :asc
    assert F.parse_status("dead") == "dead"
    assert F.parse_status("nope") == nil
  end

  test "filter matches name and url independently, case-insensitively" do
    rows = [
      src(url: "https://cafe.test", name: "Corner"),
      src(url: "https://x.test", name: "Cafe Bar")
    ]

    assert length(F.filter(rows, %{q: "cafe"})) == 2
    assert Enum.map(F.filter(rows, %{q: "corner"}), & &1.name) == ["Corner"]
  end

  test "filter by status" do
    rows = [src(status: "active", url: "a"), src(status: "dead", url: "b")]
    assert Enum.map(F.filter(rows, %{status: "dead"}), & &1.url) == ["b"]
  end

  test "sort by name falls back to url and is case-insensitive" do
    rows = [
      src(url: "https://b.test", name: "banana"),
      src(url: "https://a.test", name: "Apple"),
      src(url: "https://c.test", name: nil)
    ]

    # "Apple"/"banana" compare case-insensitively as "apple" < "banana"; the
    # nil-name row falls back to its full url "https://c.test" (scheme
    # included), which — starting with "h" — sorts after both names here.
    assert Enum.map(F.sort(rows, :name, :asc), & &1.url) == [
             "https://a.test",
             "https://b.test",
             "https://c.test"
           ]
  end

  test "sort by quality puts nulls last in both directions" do
    rows = [src(url: "a", quality_score: nil), src(url: "b", quality_score: 2.0)]
    assert Enum.map(F.sort(rows, :quality, :asc), & &1.url) == ["b", "a"]
    assert Enum.map(F.sort(rows, :quality, :desc), & &1.url) == ["b", "a"]
  end

  test "sort by checked orders DateTime values correctly across month/year boundaries" do
    # Elixir's generic `<` on DateTime structs compares struct fields in
    # alphabetical key order (day before month before year), which is NOT
    # chronological — this guards against that landmine.
    early = DateTime.from_naive!(~N[2025-12-20 00:00:00], "Etc/UTC")
    late = DateTime.from_naive!(~N[2026-01-05 00:00:00], "Etc/UTC")

    rows = [src(url: "later", last_checked_at: late), src(url: "earlier", last_checked_at: early)]

    assert Enum.map(F.sort(rows, :checked, :asc), & &1.url) == ["earlier", "later"]
    assert Enum.map(F.sort(rows, :checked, :desc), & &1.url) == ["later", "earlier"]
  end

  test "summarize counts status, finds, and averages quality over present scores only" do
    rows = [
      src(status: "active", finds_count: 3, quality_score: 4.0),
      src(status: "active", finds_count: 1, quality_score: nil),
      src(status: "dead", finds_count: 0, quality_score: 2.0)
    ]

    s = F.summarize(rows)
    assert s.total == 3
    assert s.by_status == %{"active" => 2, "paused" => 0, "dead" => 1}
    assert s.total_finds == 4
    assert s.avg_quality == 3.0
  end
end
