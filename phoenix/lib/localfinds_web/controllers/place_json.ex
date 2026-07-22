defmodule LocalfindsWeb.PlaceJSON do
  @moduledoc "The 11 contract keys, nothing else. The controller test asserts the exact set."

  def index(%{places: places}), do: Enum.map(places, &data/1)
  def show(%{place: place}), do: data(place)

  defp data(p) do
    %{
      osm_id: p.osm_id,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      kind: p.kind,
      tags: p.tags,
      address: p.address,
      town: p.town,
      website: p.website,
      phone: p.phone,
      brand: p.brand
    }
  end
end
