defmodule Localfinds.Places do
  @moduledoc """
  Queries over public.osm_places. Every query starts from the custom/%
  exclusion — custom rows carry agent provenance that must not be published.
  DBConnection.ConnectionError is rescued to {:error, :database_unavailable}:
  Postgres bounces ~weekly under apt upgrades and requests in flight should
  degrade to an honest 503, not a 500.
  """
  import Ecto.Query

  alias Localfinds.Places.{Params, Place}
  alias Localfinds.Repo

  @osm_id_re ~r{^(?:node|way|relation)/\d+$}

  @spec list_places(Params.t()) :: {:ok, [Place.t()]} | {:error, :database_unavailable}
  def list_places(%Params{} = p) do
    places =
      base()
      |> area_filter(p)
      |> keys_filter(p.keys)
      |> order_by([pl], asc: pl.name, asc: pl.osm_id)
      |> limit(^p.limit)
      |> Repo.all()

    {:ok, places}
  rescue
    DBConnection.ConnectionError -> {:error, :database_unavailable}
  end

  @spec get_place(String.t()) ::
          {:ok, Place.t()} | {:error, :not_found} | {:error, :database_unavailable}
  def get_place(osm_id) do
    if Regex.match?(@osm_id_re, osm_id) do
      case Repo.one(where(base(), [pl], pl.osm_id == ^osm_id)) do
        nil -> {:error, :not_found}
        place -> {:ok, place}
      end
    else
      {:error, :not_found}
    end
  rescue
    DBConnection.ConnectionError -> {:error, :database_unavailable}
  end

  defp base do
    from pl in Place, where: not like(pl.osm_id, "custom/%")
  end

  # Written as lower(town) = lower(?) to match osm_places_town_idx ON (lower(town)).
  defp area_filter(q, %Params{town: town}) when is_binary(town) do
    where(q, [pl], fragment("lower(?) = lower(?)", pl.town, ^town))
  end

  # ST_MakeEnvelope takes xmin,ymin,xmax,ymax = w,s,e,n — note the reorder from
  # the wire format s,w,n,e. For a point vs an envelope, && is containment and
  # uses osm_places_point_gist.
  defp area_filter(q, %Params{bbox: {s, w, n, e}}) do
    where(
      q,
      [pl],
      fragment(
        "? && ST_Transform(ST_MakeEnvelope(?, ?, ?, ?, 4326), 3857)",
        pl.point,
        ^w,
        ^s,
        ^e,
        ^n
      )
    )
  end

  # keys filters on kind (the field the API returns), not tag presence — a
  # caller asking for shop and receiving "kind": "amenity=cafe" would call
  # that a bug. Forgoing the gin index is irrelevant at 22.5k rows.
  defp keys_filter(q, nil), do: q

  defp keys_filter(q, keys) do
    where(q, [pl], fragment("split_part(?, '=', 1) = ANY(?)", pl.kind, ^keys))
  end
end
