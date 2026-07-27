defmodule Localfinds.Places.MapPinsTest do
  @moduledoc """
  The fixture DB seeds eight non-duplicate places. Six are pinnable and two are
  deliberately not:

    * Hannaford (shop=supermarket) is tier 4 in the fixture categories.json
    * Rock City Coffee carries brand="Rock City", making it a chain

  so this file exercises both exclusions against real rows rather than mocks.
  """
  # async: false — the closed-status test writes to localfinds.place_annotations.
  use ExUnit.Case, async: false

  alias Localfinds.Places
  alias Localfinds.Repo

  setup do
    Repo.query!("TRUNCATE localfinds.place_annotations RESTART IDENTITY CASCADE")
    :ok
  end

  defp names, do: Places.map_pins() |> Enum.map(& &1.name) |> Enum.sort()

  test "returns every pinnable place, excluding tier 4 and chains" do
    assert names() == [
             "Coastal Law",
             "Farnsworth Art Museum",
             "Harbor Park",
             "Owls Head Light",
             "Storer Lumber",
             "Test Custom Cafe"
           ]
  end

  test "a tier-4 place is excluded" do
    refute "Hannaford" in names()
  end

  test "a chain (brand present) is excluded" do
    refute "Rock City Coffee" in names()
  end

  test "a place marked closed is excluded" do
    assert "Harbor Park" in names()

    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, status_override) VALUES ($1, 'closed')",
      ["way/12"]
    )

    refute "Harbor Park" in names()
  end

  test "status_override 'unknown' is NOT an exclusion — only 'closed' is" do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, status_override) VALUES ($1, 'unknown')",
      ["way/12"]
    )

    assert "Harbor Park" in names()
  end

  test "a duplicate-marked place is excluded" do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, duplicate_of) VALUES ($1, $2)",
      ["way/12", "relation/-3"]
    )

    refute "Harbor Park" in names()
  end

  test "each pin carries the theme, sub-type and tier the map needs" do
    pin = Enum.find(Places.map_pins(), &(&1.name == "Farnsworth Art Museum"))

    assert pin.theme == "arts"
    assert pin.subtype == "Museum"
    assert pin.tier == 1
    assert pin.kind == "tourism=museum"
    assert pin.town == "Rockland"
    assert_in_delta pin.lat, 44.10, 0.02
    assert_in_delta pin.lng, -69.107, 0.02
  end

  test "a kind matching no theme falls back to the Other theme key" do
    pin = Enum.find(Places.map_pins(), &(&1.name == "Coastal Law"))
    assert pin.theme == "other"
    assert pin.subtype == nil
    assert pin.tier == 2
  end

  test "pins carry no status/is_chain/tags — the server already filtered on them" do
    pin = hd(Places.map_pins())

    assert Map.keys(pin) |> Enum.sort() ==
             [:kind, :lat, :lng, :name, :osm_id, :subtype, :theme, :tier, :town]
  end

  test "count_places/0 counts every non-duplicate place, pinnable or not" do
    assert Places.count_places() == 8
  end

  test "count_places/0 and map_pins/0 legitimately disagree" do
    # NOT a bug: count_places is "places catalogued" (the whole directory),
    # map_pins is "what the map may draw". The gap here is Hannaford (tier 4)
    # and Rock City Coffee (chain). A future gap can also come from rows with
    # no coordinates, which map_pins guards against but the fixture DB cannot
    # represent (custom_places.lat/lng are NOT NULL and osm_places derives
    # coordinates from geometry).
    assert Places.count_places() - length(Places.map_pins()) == 2
  end

  test "count_places/0 excludes duplicate-marked places" do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, duplicate_of) VALUES ($1, $2)",
      ["way/12", "relation/-3"]
    )

    assert Places.count_places() == 7
  end
end
