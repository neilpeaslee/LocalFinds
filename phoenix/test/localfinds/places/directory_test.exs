defmodule Localfinds.Places.DirectoryTest do
  # async: false — the annotation tests write to localfinds.place_annotations.
  use ExUnit.Case, async: false

  alias Localfinds.Places
  alias Localfinds.Places.DirectoryPlace
  alias Localfinds.Repo

  setup do
    Repo.query!("TRUNCATE localfinds.place_annotations RESTART IDENTITY CASCADE")
    :ok
  end

  defp names(filters \\ %{}), do: Enum.map(Places.list_directory_places(filters), & &1.name)

  test "lists every fixture place ordered by town then name" do
    assert names() == [
             "Coastal Law",
             "Farnsworth Art Museum",
             "Hannaford",
             "Harbor Park",
             "Owls Head Light",
             "Rock City Coffee",
             "Storer Lumber",
             "Test Custom Cafe"
           ]
  end

  test "includes custom/ rows — provenance exclusion is an API-only rule" do
    assert "Test Custom Cafe" in names()
  end

  test "town filter is an exact match, matching the SQL the Next page runs" do
    assert length(names(%{town: "Rockland"})) == 8
    assert names(%{town: "rockland"}) == []
    assert names(%{town: "Camden"}) == []
  end

  test "q matches the name case-insensitively, anywhere in the string" do
    assert names(%{q: "coffee"}) == ["Rock City Coffee"]
    assert names(%{q: "HARBOR"}) == ["Harbor Park"]
  end

  test "q escapes LIKE metacharacters so they match literally" do
    assert names(%{q: "%"}) == []
    assert names(%{q: "_"}) == []
  end

  test "tag filter: a bare key matches any value of that key" do
    assert names(%{tag: "tourism"}) == ["Farnsworth Art Museum", "Owls Head Light"]
  end

  test "tag filter: key=value is an exact value match" do
    assert names(%{tag: "amenity=cafe"}) == ["Rock City Coffee", "Test Custom Cafe"]
    assert names(%{tag: "amenity=restaurant"}) == []
  end

  test "tag filter: a trailing = falls back to key existence" do
    assert names(%{tag: "leisure="}) == ["Harbor Park"]
  end

  test "limit truncates the ordered result" do
    assert names(%{limit: 2}) == ["Coastal Law", "Farnsworth Art Museum"]
  end

  test "rows marked as duplicates drop out of the list but stay fetchable" do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, duplicate_of, added_by) VALUES ('node/1', 'node/11', 'test')"
    )

    refute "Rock City Coffee" in names()
    assert %DirectoryPlace{name: "Rock City Coffee"} = Places.get_directory_place("node/1")
  end

  test "status is the effective status — an override wins over OSM presence" do
    assert Places.get_directory_place("way/2").status == "active"

    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, status_override, added_by) VALUES ('way/2', 'closed', 'test')"
    )

    place = Places.get_directory_place("way/2")
    assert place.status == "closed"
    assert place.status_override == "closed"
  end

  test "status filter reads the effective status" do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, status_override, added_by) VALUES ('way/2', 'closed', 'test')"
    )

    assert names(%{status: "closed"}) == ["Hannaford"]
    assert length(names(%{status: "active"})) == 7
  end

  test "the annotation note rides along on the row" do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, note, added_by) VALUES ('way/12', '## Great in summer', 'test')"
    )

    assert Places.get_directory_place("way/12").annotation_note == "## Great in summer"
  end

  test "get_directory_place/1 returns nil for an unknown id" do
    assert Places.get_directory_place("node/999999") == nil
  end

  test "tag_list/1 bridges the jsonb tag set to sorted key=value strings" do
    tags = DirectoryPlace.tag_list(Places.get_directory_place("node/11"))
    assert tags == ["craft=sawmill", "name=Storer Lumber"]
  end

  test "list_towns/0 counts non-duplicate places per town" do
    assert Places.list_towns() == [%{town: "Rockland", n: 8}]

    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, duplicate_of, added_by) VALUES ('node/1', 'node/11', 'test')"
    )

    assert Places.list_towns() == [%{town: "Rockland", n: 7}]
  end
end
