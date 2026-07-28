defmodule Localfinds.TownBoundaries do
  @moduledoc """
  Town boundary polygons from `data/config/town-boundaries.json` — port of
  `readTownBoundaries()` plus `featureOuterRings()` from `RegionMap.tsx`.

  Two transformations happen here rather than in the JS hook, because they are
  pure data reshaping and are cheaper to test in ExUnit:

    * Only the **outer** ring of each polygon is kept. Holes exist in the source
      data and drawing them as separate outlines would put stray loops on the map.
    * Coordinates are flipped from GeoJSON's `[lng, lat]` to Leaflet's
      `[lat, lng]`, so the hook hands rings straight to `L.polygon`.

  A missing or malformed file yields `[]`, and the map degrades to the bbox
  rectangles `Localfinds.Towns` provides.
  """

  alias Localfinds.DataDir

  @type t :: %{name: String.t(), primary: boolean(), rings: [[[number()]]]}

  @spec load() :: [t()]
  def load, do: load(DataDir.path())

  @spec load(String.t() | nil) :: [t()]
  def load(nil), do: []

  def load(dir) do
    file = Path.join([dir, "config", "town-boundaries.json"])

    [file, file <> ".example"]
    |> Enum.find_value([], &read_features/1)
  end

  defp read_features(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, %{} = json} <- Jason.decode(raw) do
      json |> Map.get("features") |> normalize()
    else
      _ -> nil
    end
  end

  defp normalize(features) when is_list(features) do
    for f <- features,
        is_map(f),
        is_binary(get_in(f, ["properties", "name"])),
        rings = outer_rings(f["geometry"]),
        rings != [] do
      %{
        name: f["properties"]["name"],
        primary: get_in(f, ["properties", "primary"]) == true,
        rings: rings
      }
    end
  end

  defp normalize(_), do: []

  defp outer_rings(%{"type" => "Polygon", "coordinates" => [outer | _holes]}),
    do: flip_ring(outer)

  defp outer_rings(%{"type" => "MultiPolygon", "coordinates" => polys}) when is_list(polys) do
    Enum.flat_map(polys, fn
      [outer | _holes] -> flip_ring(outer)
      _ -> []
    end)
  end

  defp outer_rings(_), do: []

  # Returns a LIST of rings (zero or one) so both clauses above can concatenate
  # uniformly — a ring that isn't a list of [lng, lat] pairs contributes nothing.
  defp flip_ring(ring) when is_list(ring) do
    points =
      for [lng, lat] <- ring, is_number(lng), is_number(lat) do
        [lat, lng]
      end

    if points == [], do: [], else: [points]
  end

  defp flip_ring(_), do: []
end
