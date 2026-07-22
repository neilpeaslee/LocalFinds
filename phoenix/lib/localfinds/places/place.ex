defmodule Localfinds.Places.Place do
  @moduledoc """
  Read-only projection of public.osm_places (a matview — no writes possible,
  and the DB role can only SELECT). No changesets, ever. `point` is declared
  :binary and never selected: referenceable in bbox fragments without a
  geometry codec (geo_postgis is deliberately not a dependency).
  """
  use Ecto.Schema

  @primary_key {:osm_id, :string, autogenerate: false}
  schema "osm_places" do
    field :name, :string
    field :kind, :string
    field :lat, :float
    field :lng, :float
    field :tags, :map
    field :address, :string
    field :town, :string
    field :website, :string
    field :phone, :string
    field :brand, :string
    field :point, :binary, load_in_query: false
  end
end
