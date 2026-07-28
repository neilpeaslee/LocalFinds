defmodule Localfinds.Places.MapPinsTest do
  @moduledoc """
  The fixture DB seeds eight non-duplicate places. Six are pinnable and two are
  deliberately not:

    * Hannaford (shop=supermarket) is tier 4 in the fixture categories.json
    * Rock City Coffee carries brand="Rock City", making it a chain

  so this file exercises both exclusions against real rows rather than mocks.

  `map_pins/0`'s return shape IS the wire contract `assets/js/hooks/region_map.js`
  reads (short keys, no `town`/`tier`, coordinates rounded to 5dp) — see the
  moduledoc on `map_pins/0` for why.
  """
  # async: false — the closed-status test writes to localfinds.place_annotations.
  use ExUnit.Case, async: false

  alias Localfinds.Places
  alias Localfinds.Repo

  setup do
    Repo.query!("TRUNCATE localfinds.place_annotations RESTART IDENTITY CASCADE")
    :ok
  end

  defp names, do: Places.map_pins() |> Enum.map(& &1.nm) |> Enum.sort()

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

  test "each pin carries its theme and sub-type, under the wire's short keys" do
    pin = Enum.find(Places.map_pins(), &(&1.nm == "Farnsworth Art Museum"))

    assert pin.th == "arts"
    assert pin.sub == "Museum"
    assert pin.kd == "tourism=museum"
    assert_in_delta pin.lat, 44.10, 0.02
    assert_in_delta pin.lng, -69.107, 0.02
  end

  test "a kind matching no theme falls back to the Other theme key" do
    pin = Enum.find(Places.map_pins(), &(&1.nm == "Coastal Law"))
    assert pin.th == "other"
    assert pin.sub == nil
  end

  test "pins carry no status/is_chain/tags/town/tier — only the wire's short keys" do
    pin = hd(Places.map_pins())

    assert Map.keys(pin) |> Enum.sort() == [:id, :kd, :lat, :lng, :nm, :sub, :th]
  end

  test "town is absent — region_map.js never reads it" do
    refute Enum.any?(Places.map_pins(), &Map.has_key?(&1, :town))
  end

  test "tier is absent — it only ever selected the tier-4 reject above, server-side" do
    refute Enum.any?(Places.map_pins(), &Map.has_key?(&1, :tier))
  end

  test "lat/lng are rounded to 5 decimal places, not shipped at full float precision" do
    # These places' raw geometry-derived coordinates carry ~14 significant
    # digits (a float round-trip through ST_Transform) — noise no pin needs.
    farnsworth = Enum.find(Places.map_pins(), &(&1.nm == "Farnsworth Art Museum"))
    coastal_law = Enum.find(Places.map_pins(), &(&1.nm == "Coastal Law"))

    assert farnsworth.lat == 44.104
    assert farnsworth.lng == -69.107
    assert coastal_law.lat == 44.101
    assert coastal_law.lng == -69.112
  end

  test "count_places/0 counts every non-duplicate place, pinnable or not" do
    assert Places.count_places() == 8
  end

  test "count_places/0 and map_pins/0 legitimately disagree" do
    # NOT a bug: count_places is "places catalogued" (the whole directory),
    # map_pins is "what the map may draw". The gap here is Hannaford (tier 4)
    # and Rock City Coffee (chain). A future gap can also come from
    # coordinate-less rows, which map_pins guards against — no row in this
    # fixture data happens to be coordinate-less, but such a row is
    # schema-legal (an OSM node with a null geometry), not impossible.
    assert Places.count_places() - length(Places.map_pins()) == 2
  end

  test "count_places/0 excludes duplicate-marked places" do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, duplicate_of) VALUES ($1, $2)",
      ["way/12", "relation/-3"]
    )

    assert Places.count_places() == 7
  end

  test "count_places/0 stays closed-inclusive while map_pins/0 excludes the closed place" do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, status_override) VALUES ($1, 'closed')",
      ["way/12"]
    )

    assert Places.count_places() == 8
    refute "Harbor Park" in names()
  end
end
