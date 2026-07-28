defmodule Localfinds.TownBoundariesTest do
  use ExUnit.Case, async: true

  alias Localfinds.TownBoundaries

  setup do
    dir = Path.join(System.tmp_dir!(), "boundaries_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(dir, "config"))
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  defp write!(dir, name, body), do: File.write!(Path.join([dir, "config", name]), body)

  test "load/0 reads the fixture, dropping the feature with no name" do
    assert Enum.map(TownBoundaries.load(), & &1.name) == ["Rockland", "Owls Head"]
  end

  test "coordinates are flipped from GeoJSON [lng, lat] to Leaflet [lat, lng]" do
    [rockland | _] = TownBoundaries.load()
    [ring] = rockland.rings
    assert hd(ring) == [44.05, -69.20]
  end

  test "only the outer ring of a Polygon is kept — holes are dropped" do
    [rockland | _] = TownBoundaries.load()
    assert length(rockland.rings) == 1
    assert length(hd(rockland.rings)) == 5
  end

  test "a MultiPolygon yields one ring per part" do
    [_, owls_head] = TownBoundaries.load()
    assert length(owls_head.rings) == 2
    refute owls_head.primary
  end

  test "primary is carried through from properties" do
    [rockland | _] = TownBoundaries.load()
    assert rockland.primary
  end

  test "an unreadable dir yields an empty list, never a crash", %{dir: dir} do
    assert TownBoundaries.load(Path.join(dir, "does-not-exist")) == []
    assert TownBoundaries.load(nil) == []
  end

  test "malformed JSON falls through to the .example template", %{dir: dir} do
    write!(dir, "town-boundaries.json", "{ not json")

    write!(dir, "town-boundaries.json.example", ~s({"features": [
      {"properties": {"name": "Fallback"},
       "geometry": {"type": "Polygon", "coordinates": [[[-1.0, 2.0], [-1.5, 2.5]]]}}
    ]}))

    [only] = TownBoundaries.load(dir)
    assert only.name == "Fallback"
    assert only.rings == [[[2.0, -1.0], [2.5, -1.5]]]
  end

  test "a feature with an unknown geometry type is dropped, not crashed on", %{dir: dir} do
    write!(dir, "town-boundaries.json", ~s({"features": [
      {"properties": {"name": "Point Town"},
       "geometry": {"type": "Point", "coordinates": [-69.0, 44.0]}},
      {"properties": {"name": "Real"},
       "geometry": {"type": "Polygon", "coordinates": [[[-69.0, 44.0]]]}}
    ]}))

    assert Enum.map(TownBoundaries.load(dir), & &1.name) == ["Real"]
  end

  test "a valid-but-empty town-boundaries.json does NOT fall through to .example", %{dir: dir} do
    write!(dir, "town-boundaries.json", ~s({"features": []}))

    write!(dir, "town-boundaries.json.example", ~s({"features": [
      {"properties": {"name": "ShouldNotAppear"},
       "geometry": {"type": "Polygon", "coordinates": [[[-1.0, 2.0], [-1.5, 2.5]]]}}
    ]}))

    assert TownBoundaries.load(dir) == []
  end
end
