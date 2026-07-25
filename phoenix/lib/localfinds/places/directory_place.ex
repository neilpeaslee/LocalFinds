defmodule Localfinds.Places.DirectoryPlace do
  @moduledoc """
  Read-only projection of the `localfinds.places` VIEW — OSM catalog facts
  left-joined to the LocalFinds annotation overlay. This is the row the web
  directory renders, and it is deliberately a different schema from
  `Localfinds.Places.Place` (the `public.osm_places` API projection, which has
  no annotation columns and excludes custom rows).

  No changesets, ever: the view is not updatable and the prod role only SELECTs.
  `tags` is the full OSM tag set as jsonb; `tag_list/1` bridges it to the
  `key=value` list the UI renders (the C7 convention the TS `PLACE_COLS` builds
  in SQL).
  """
  use Ecto.Schema

  @primary_key {:osm_id, :string, autogenerate: false}
  @schema_prefix "localfinds"
  schema "places" do
    field :name, :string
    field :kind, :string
    field :lat, :float
    field :lng, :float
    field :town, :string
    field :address, :string
    field :website, :string
    field :phone, :string
    field :brand, :string
    field :tags, :map
    field :status, :string
    field :status_override, :string
    field :annotation_note, :string
    field :duplicate_of, :string
  end

  @type t :: %__MODULE__{}

  @spec tag_list(t() | nil) :: [String.t()]
  def tag_list(%__MODULE__{tags: tags}) when is_map(tags) do
    tags
    |> Enum.map(fn {key, value} -> "#{key}=#{value}" end)
    |> Enum.sort()
  end

  def tag_list(_), do: []
end
