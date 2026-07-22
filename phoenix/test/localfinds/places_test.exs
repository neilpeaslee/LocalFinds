defmodule Localfinds.PlacesTest do
  use ExUnit.Case, async: true

  alias Localfinds.Places
  alias Localfinds.Places.Params

  defp ok!(params) do
    {:ok, validated} = Params.validate(params)
    {:ok, places} = Places.list_places(validated)
    places
  end

  @sorted_names [
    "Coastal Law",
    "Farnsworth Art Museum",
    "Hannaford",
    "Harbor Park",
    "Owls Head Light",
    "Rock City Coffee",
    "Storer Lumber"
  ]

  test "town query returns all 7 OSM places ordered by name (relation/6 collapsed to one)" do
    assert Enum.map(ok!(%{"town" => "Rockland"}), & &1.name) == @sorted_names
  end

  test "town match is case-insensitive (lower() expression-index shape)" do
    assert length(ok!(%{"town" => "rockland"})) == 7
  end

  test "unknown town returns []" do
    assert ok!(%{"town" => "Camden"}) == []
  end

  test "wide bbox returns all 7" do
    assert length(ok!(%{"bbox" => "44.05,-69.20,44.15,-69.05"})) == 7
  end

  test "narrow bbox around Hannaford returns exactly it" do
    assert Enum.map(ok!(%{"bbox" => "44.094,-69.116,44.099,-69.111"}), & &1.name) ==
             ["Hannaford"]
  end

  test "keys filters on kind: tourism → the two museums" do
    assert Enum.map(ok!(%{"town" => "Rockland", "keys" => "tourism"}), & &1.name) ==
             ["Farnsworth Art Museum", "Owls Head Light"]
  end

  test "keys filters on kind: shop,office → Hannaford + Coastal Law" do
    assert Enum.map(ok!(%{"town" => "Rockland", "keys" => "shop,office"}), & &1.name) ==
             ["Coastal Law", "Hannaford"]
  end

  test "limit truncates the reproducible order" do
    {:ok, p} = Params.validate(%{"town" => "Rockland", "limit" => "2"})
    {:ok, places} = Places.list_places(p)
    assert Enum.map(places, & &1.name) == ["Coastal Law", "Farnsworth Art Museum"]
  end

  test "custom/% rows never appear in a list — the provenance-leak guard" do
    refute Enum.any?(ok!(%{"town" => "Rockland"}), &String.starts_with?(&1.osm_id, "custom/"))
    refute Enum.any?(
             ok!(%{"bbox" => "44.05,-69.20,44.15,-69.05"}),
             &String.starts_with?(&1.osm_id, "custom/")
           )
  end

  test "detail projects the full contract shape for node/1" do
    {:ok, place} = Places.get_place("node/1")
    assert place.name == "Rock City Coffee"
    assert place.kind == "amenity=cafe"
    assert place.town == "Rockland"
    assert place.address == "316 Main Street, Rockland"
    assert place.website == "https://rockcity.example"
    assert place.phone == "+1-207-555-0100"
    assert place.brand == "Rock City"
    assert place.tags["cuisine"] == "coffee_shop"
    assert_in_delta place.lat, 44.10, 0.001
    assert_in_delta place.lng, -69.11, 0.001
  end

  test "detail resolves way/ and relation/ ids" do
    assert {:ok, %{name: "Hannaford"}} = Places.get_place("way/2")
    assert {:ok, %{name: "Farnsworth Art Museum"}} = Places.get_place("relation/3")
  end

  test "detail: missing id is not_found" do
    assert {:error, :not_found} = Places.get_place("node/999999")
  end

  test "detail: custom/<n> fails the regex — not_found, never a row" do
    %{rows: [[custom_id]]} =
      Localfinds.Repo.query!(
        "SELECT osm_id FROM public.osm_places WHERE osm_id LIKE 'custom/%' LIMIT 1"
      )

    assert {:error, :not_found} = Places.get_place(custom_id)
  end

  test "detail: garbage id is not_found" do
    assert {:error, :not_found} = Places.get_place("bogus")
  end
end
