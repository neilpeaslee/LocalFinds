defmodule Localfinds.Places do
  @moduledoc """
  Queries over public.osm_places. Every query starts from the custom/%
  exclusion — custom rows carry agent provenance that must not be published.
  Database failures are routed through Localfinds.DB.guard/1, which degrades
  a dropped connection or a server shutdown to {:error, :database_unavailable}:
  Postgres bounces ~weekly under apt upgrades and requests in flight should
  degrade to an honest 503, not a 500.
  """
  import Ecto.Query

  alias Localfinds.DB
  alias Localfinds.Places.{DirectoryPlace, Params, Place}
  alias Localfinds.Repo

  @osm_id_re ~r{^(?:node|way|relation)/\d+$}

  @spec list_places(Params.t()) :: {:ok, [Place.t()]} | {:error, :database_unavailable}
  def list_places(%Params{} = p) do
    DB.guard(fn ->
      base()
      |> area_filter(p)
      |> keys_filter(p.keys)
      |> order_by([pl], asc: pl.name, asc: pl.osm_id)
      |> limit(^p.limit)
      |> Repo.all()
    end)
  end

  @spec get_place(String.t()) ::
          {:ok, Place.t()} | {:error, :not_found} | {:error, :database_unavailable}
  def get_place(osm_id) do
    case DB.guard(fn -> fetch_place(osm_id) end) do
      {:ok, result} -> result
      {:error, :database_unavailable} = degraded -> degraded
    end
  end

  defp fetch_place(osm_id) do
    if Regex.match?(@osm_id_re, osm_id) do
      case Repo.one(where(base(), [pl], pl.osm_id == ^osm_id)) do
        nil -> {:error, :not_found}
        place -> {:ok, place}
      end
    else
      {:error, :not_found}
    end
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

  # =========================================================================
  # Directory reads (localfinds.places view) — what the web UI renders. Port of
  # listPlaces / getPlaceByOsmId / listPlaceTowns in packages/db/src/queries.ts.
  # These raise on failure; LiveViews call them through LocalfindsWeb.LiveDB,
  # which applies Localfinds.DB.guard/1.
  # =========================================================================

  @directory_limit 5000

  @spec list_directory_places(map()) :: [DirectoryPlace.t()]
  def list_directory_places(filters \\ %{}) do
    DirectoryPlace
    |> where([pl], is_nil(pl.duplicate_of))
    |> town_filter(Map.get(filters, :town))
    |> status_filter(Map.get(filters, :status))
    |> tag_filter(Map.get(filters, :tag))
    |> name_filter(Map.get(filters, :q))
    |> order_by([pl], asc: pl.town, asc: pl.name)
    |> limit(^Map.get(filters, :limit, @directory_limit))
    |> Repo.all()
  end

  @spec get_directory_place(String.t()) :: DirectoryPlace.t() | nil
  def get_directory_place(osm_id) when is_binary(osm_id) do
    Repo.one(from pl in DirectoryPlace, where: pl.osm_id == ^osm_id)
  end

  @spec list_towns() :: [%{town: String.t(), n: integer()}]
  def list_towns do
    Repo.all(
      from pl in DirectoryPlace,
        where: not is_nil(pl.town) and is_nil(pl.duplicate_of),
        group_by: pl.town,
        order_by: pl.town,
        select: %{town: pl.town, n: count(pl.osm_id)}
    )
  end

  defp town_filter(q, nil), do: q
  defp town_filter(q, town), do: where(q, [pl], pl.town == ^town)

  defp status_filter(q, nil), do: q
  defp status_filter(q, status), do: where(q, [pl], pl.status == ^status)

  defp name_filter(q, nil), do: q
  defp name_filter(q, term), do: where(q, [pl], ilike(pl.name, ^like_contains(term)))

  # Escape LIKE metacharacters so a visitor's search text matches literally
  # ("50%" must not become a wildcard). Backslash is Postgres's default LIKE
  # escape character, so no ESCAPE clause is needed.
  defp like_contains(term), do: "%" <> String.replace(term, ~r/[\\%_]/, "\\\\\\0") <> "%"

  # Value-aware OSM tag filter, matching the TS behaviour exactly: split on the
  # FIRST "=", so "amenity=cafe" is an exact value match while a bare key (or a
  # trailing "=") means key existence. `\\?` is an escaped literal "?" — Ecto
  # reads a bare ? as a parameter placeholder — so this is the indexed jsonb
  # existence operator, not the jsonb_exists() function (which the planner will
  # not match to gin(tags), migration 0006).
  #
  # The value-match branch binds a raw Elixir map (not a pre-encoded JSON
  # string) to the ?::jsonb parameter: Postgrex infers the jsonb OID from the
  # cast and serializes a map correctly, but a String.t() it receives is
  # treated as an already-decoded jsonb *value* and gets JSON-encoded a
  # second time — producing a jsonb scalar string, not an object, so `@>`
  # containment silently matches nothing.
  defp tag_filter(q, nil), do: q

  defp tag_filter(query, tag) do
    case :binary.match(tag, "=") do
      {idx, _} when idx > 0 and idx < byte_size(tag) - 1 ->
        key = binary_part(tag, 0, idx)
        value = binary_part(tag, idx + 1, byte_size(tag) - idx - 1)
        where(query, [pl], fragment("? @> ?::jsonb", pl.tags, ^%{key => value}))

      {idx, _} when idx > 0 ->
        where(query, [pl], fragment("? \\? ?", pl.tags, ^binary_part(tag, 0, idx)))

      _ ->
        where(query, [pl], fragment("? \\? ?", pl.tags, ^tag))
    end
  end
end
