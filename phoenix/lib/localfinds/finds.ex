defmodule Localfinds.Finds do
  @moduledoc """
  Read queries over localfinds.finds. Port of the finds reads in
  packages/db/src/queries.ts. The feed page composes its filters here.
  """
  import Ecto.Query

  alias Localfinds.Finds.Find
  alias Localfinds.Pagination
  alias Localfinds.Repo

  @spec list_by_source(integer(), pos_integer()) :: [Find.t()]
  def list_by_source(source_id, limit \\ 10) do
    Repo.all(
      from f in Find,
        where: f.source_id == ^source_id,
        order_by: [desc: f.discovered_at],
        limit: ^limit
    )
  end

  @doc """
  One page of the feed — port of `getFeedPage`.

  Every filter key is optional; the shape is the `resolved` map from
  `LocalfindsWeb.FeedURL.resolve/2`. A `:page_size` of `:all` (or absent)
  returns the whole matching set on a single page, matching the reference's
  "no page size" branch.
  """
  @spec feed_page(map()) :: %{
          rows: [Find.t()],
          total: non_neg_integer(),
          page: pos_integer(),
          page_count: pos_integer()
        }
  def feed_page(filters \\ %{}) do
    base = base_query(filters)
    total = Repo.aggregate(base, :count, :id)
    ordered = order_by_sort(base, Map.get(filters, :sort))

    case Map.get(filters, :page_size) do
      size when size in [nil, :all] ->
        %{rows: Repo.all(ordered), total: total, page: 1, page_count: 1}

      size ->
        window = Pagination.resolve_page(total, Map.get(filters, :page, 1), size)
        rows = Repo.all(from f in ordered, limit: ^size, offset: ^window.start)
        %{rows: rows, total: total, page: window.page, page_count: window.page_count}
    end
  end

  defp base_query(filters) do
    Find
    |> view_clause(Map.get(filters, :view, "default"))
    |> days_clause(Map.get(filters, :days))
    |> from_clause(Map.get(filters, :from))
    |> to_clause(Map.get(filters, :to))
    |> tag_clause(Map.get(filters, :tag))
    |> type_clause(Map.get(filters, :type))
  end

  # The four views, port of `feedWhere`. "all" deliberately applies no status or
  # expiry clause at all.
  defp view_clause(query, "all"), do: query
  defp view_clause(query, "hidden"), do: where(query, [f], f.status == "hidden")

  defp view_clause(query, "starred"),
    do: query |> where([f], f.status == "starred") |> unexpired()

  defp view_clause(query, _default),
    do: query |> where([f], f.status not in ["hidden", "provisional"]) |> unexpired()

  defp unexpired(query),
    do: where(query, [f], is_nil(f.expires_at) or f.expires_at >= ^utc_midnight_today())

  defp days_clause(query, nil), do: query

  defp days_clause(query, days) do
    since = DateTime.add(DateTime.utc_now(), -days * 86_400, :second)
    where(query, [f], f.discovered_at >= ^since)
  end

  defp from_clause(query, nil), do: query
  defp from_clause(query, date), do: where(query, [f], f.event_start >= ^start_of_day(date))

  defp to_clause(query, nil), do: query
  defp to_clause(query, date), do: where(query, [f], f.event_start <= ^end_of_day(date))

  defp tag_clause(query, nil), do: query
  defp tag_clause(query, tag), do: where(query, [f], fragment("? = ANY(?)", ^tag, f.tags))

  defp type_clause(query, nil), do: query
  defp type_clause(query, type), do: where(query, [f], f.type == ^type)

  defp order_by_sort(query, "oldest"), do: order_by(query, [f], asc: f.discovered_at)

  # Undated finds sink to the end, matching `(event_start IS NULL), event_start ASC`.
  defp order_by_sort(query, "soonest"),
    do: order_by(query, [f], asc: fragment("(? IS NULL)", f.event_start), asc: f.event_start)

  defp order_by_sort(query, _newest), do: order_by(query, [f], desc: f.discovered_at)

  # The reference binds `new Date().toISOString().slice(0, 10)` — a UTC date that
  # Postgres casts to midnight. Build it explicitly so the boundary does not move
  # with the server's timezone.
  defp utc_midnight_today, do: DateTime.new!(Date.utc_today(), ~T[00:00:00], "Etc/UTC")

  defp start_of_day(date),
    do: DateTime.new!(Date.from_iso8601!(date), ~T[00:00:00], "Etc/UTC")

  # The reference binds `${to}T23:59:59.999Z` — the end date is inclusive.
  defp end_of_day(date),
    do: DateTime.new!(Date.from_iso8601!(date), ~T[23:59:59.999], "Etc/UTC")

  @doc """
  Distinct tags among currently feed-visible finds, most frequent first.

  Raw SQL rather than Ecto: the reference is a `unnest(tags)` lateral join, which
  the query DSL expresses poorly and which has no schema to map onto. The tag
  name is added as a tiebreak so equal counts order deterministically — the
  reference leaves that to the planner.
  """
  @spec list_active_tags(pos_integer()) :: [String.t()]
  def list_active_tags(limit \\ 30) do
    %{rows: rows} =
      Repo.query!(
        """
        SELECT t FROM localfinds.finds, unnest(tags) AS t
        WHERE status NOT IN ('hidden', 'provisional')
          AND (expires_at IS NULL OR expires_at >= $1)
        GROUP BY t ORDER BY count(*) DESC, t ASC LIMIT $2
        """,
        [utc_midnight_today(), limit]
      )

    List.flatten(rows)
  end

  @doc "Distinct find types among currently feed-visible finds, most frequent first."
  @spec list_find_types() :: [String.t()]
  def list_find_types do
    %{rows: rows} =
      Repo.query!(
        """
        SELECT type FROM localfinds.finds
        WHERE status NOT IN ('hidden', 'provisional')
          AND (expires_at IS NULL OR expires_at >= $1)
        GROUP BY type ORDER BY count(*) DESC, type ASC
        """,
        [utc_midnight_today()]
      )

    List.flatten(rows)
  end
end
