defmodule Localfinds.Finds do
  @moduledoc """
  Read queries over localfinds.finds. Port of the finds reads in
  packages/db/src/queries.ts. The feed page composes its filters here.
  """
  import Ecto.Query

  alias Localfinds.Finds.Feedback
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

  # The reference binds `${to}T23:59:59.999Z` to make the end date inclusive, but
  # `event_start` here is `:utc_datetime` (second precision): Ecto casts any bound
  # value through the field's type before it reaches Postgres, so a `.999`
  # literal is truncated to `:59` before the query ever runs, silently dropping
  # the final sub-second of the day. A strict `<` against the start of the
  # *next* day covers the same inclusive whole-day range without depending on
  # sub-second precision at the boundary at all.
  defp to_clause(query, date),
    do: where(query, [f], f.event_start < ^start_of_day(day_after(date)))

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

  defp day_after(date), do: date |> Date.from_iso8601!() |> Date.add(1) |> Date.to_iso8601()

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

  @feedback_actions ~w(thumbs_up thumbs_down star unstar hide unhide)
  @statuses ~w(new shown hidden starred)

  # Star/hide change what the feed shows AND are recorded as taste signal;
  # thumbs are pure signal for the agents.
  @status_effect %{
    "star" => "starred",
    "unstar" => "shown",
    "hide" => "hidden",
    "unhide" => "shown"
  }

  @spec feedback_actions() :: [String.t()]
  def feedback_actions, do: @feedback_actions

  @doc """
  Record one feedback action — port of `submitFeedback`.

  The insert and the status change run in a transaction. The reference issues
  them as two independent statements; a thumbs-up that records the signal but
  loses the star is worth preventing, and the transaction costs nothing.
  """
  @spec record_feedback(integer(), String.t()) ::
          {:ok, map()} | {:error, :invalid_action} | {:error, any(), any(), any()}
  def record_feedback(find_id, action) when action in @feedback_actions do
    # A plain struct passed to Multi.insert has no declared constraints, so a
    # foreign-key violation (a find_id with no matching find) would raise
    # Ecto.ConstraintError instead of failing the transaction cleanly. Building
    # a changeset and declaring foreign_key_constraint/2 turns that violation
    # into an {:error, changeset} the Multi can hand back normally.
    changeset =
      %Feedback{find_id: find_id, action: action}
      |> Ecto.Changeset.change()
      |> Ecto.Changeset.foreign_key_constraint(:find_id)

    Ecto.Multi.new()
    |> Ecto.Multi.insert(:feedback, changeset)
    |> maybe_set_status(find_id, Map.get(@status_effect, action))
    |> Repo.transaction()
  end

  def record_feedback(_find_id, _action), do: {:error, :invalid_action}

  defp maybe_set_status(multi, _find_id, nil), do: multi

  defp maybe_set_status(multi, find_id, status) do
    Ecto.Multi.update_all(
      multi,
      :status,
      from(f in Find, where: f.id == ^find_id),
      set: [status: status]
    )
  end

  @doc "Set one find's status. Returns the number of rows changed."
  @spec update_status(integer(), String.t()) :: non_neg_integer()
  def update_status(find_id, status) when status in @statuses do
    {n, _} = Repo.update_all(from(f in Find, where: f.id == ^find_id), set: [status: status])
    n
  end

  def update_status(_find_id, _status), do: 0

  @doc """
  Bulk status change for feed management — port of `updateFindStatuses`.
  Status-only, no feedback rows, so a sweep of the visible page does not flood
  the agents' taste signal.
  """
  @spec update_statuses([integer()], String.t()) :: non_neg_integer()
  def update_statuses([], _status), do: 0

  def update_statuses(ids, status) when status in @statuses do
    {n, _} = Repo.update_all(from(f in Find, where: f.id in ^ids), set: [status: status])
    n
  end

  def update_statuses(_ids, _status), do: 0

  @spec unhide_all() :: non_neg_integer()
  def unhide_all do
    {n, _} = Repo.update_all(from(f in Find, where: f.status == "hidden"), set: [status: "shown"])
    n
  end
end
