defmodule LocalfindsWeb.FeedURL do
  @moduledoc """
  The URL half of the feed's state — port of `apps/web/src/lib/feed-url.ts` and
  the `resolveFeed` half of `settings.ts`.

  `href/3` builds `/feed` links that encode **only what differs from the
  persisted cookie defaults**. Omitting a param means "use the cookie default",
  which is exactly how `resolve/2` reads it back, so a value equal to the
  default is dropped and any other value — including a hardcoded default that
  differs from the cookie — is emitted explicitly. Without that, picking size 50
  while the cookie default is 25 would drop `size` and silently revert to 25.

  `days=any` is the sentinel for "explicitly no date filter": absence alone
  cannot say that, because absence means "fall back to the cookie".

  Param order matches the reference (view, sort, density, size, dates, tag,
  type, page) so URLs can be compared side by side with the Next page.
  """

  alias Localfinds.FeedSettings
  alias LocalfindsWeb.Pagination

  @type state :: %{
          view: String.t(),
          days: pos_integer() | nil,
          from: String.t() | nil,
          to: String.t() | nil,
          tag: String.t() | nil,
          type: String.t() | nil,
          page_size: FeedSettings.page_size(),
          density: String.t(),
          sort: String.t()
        }

  @type resolved :: %{
          view: String.t(),
          days: pos_integer() | nil,
          from: String.t() | nil,
          to: String.t() | nil,
          tag: String.t() | nil,
          type: String.t() | nil,
          page_size: FeedSettings.page_size(),
          density: String.t(),
          sort: String.t(),
          page: pos_integer()
        }

  @spec resolve(map(), FeedSettings.t()) :: resolved()
  def resolve(params, defaults) do
    url_from = FeedSettings.valid_date(params["from"])
    url_to = FeedSettings.valid_date(params["to"])
    raw_days = params["days"]
    url_days = FeedSettings.valid_days(raw_days)

    {days, from, to} =
      cond do
        url_from || url_to -> {nil, url_from, url_to}
        url_days -> {url_days, nil, nil}
        raw_days == "any" -> {nil, nil, nil}
        defaults.from || defaults.to -> {nil, defaults.from, defaults.to}
        true -> {defaults.days, nil, nil}
      end

    %{
      view: FeedSettings.valid_view(params["view"]) || defaults.view,
      days: days,
      from: from,
      to: to,
      # Tag and type are ad-hoc: URL only, never persisted as a default.
      tag: presence(params["tag"]),
      type: presence(params["type"]),
      page_size: resolve_size(params["size"], defaults.page_size),
      density: FeedSettings.valid_density(params["density"]) || defaults.density,
      sort: FeedSettings.valid_sort(params["sort"]) || defaults.sort,
      # Page is always ad-hoc; the pager re-adds it, every other link drops it.
      page: Pagination.parse_page(params["page"])
    }
  end

  # ?size= uses the *defaulting* parser (junk -> 50), unlike the cookie and the
  # settings form, which use FeedSettings.valid_page_size/1 (junk -> nil, so the
  # caller falls through). Conflating the two silently resets a saved default.
  defp resolve_size(nil, fallback), do: fallback
  defp resolve_size("", fallback), do: fallback
  defp resolve_size(raw, _fallback), do: Pagination.parse_page_size(raw)

  defp presence(nil), do: nil

  defp presence(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp presence(_), do: nil

  @spec href(state(), FeedSettings.t(), pos_integer() | nil) :: String.t()
  def href(state, defaults, page \\ nil) do
    query =
      []
      |> put_diff("view", state.view, defaults.view)
      |> put_diff("sort", state.sort, defaults.sort)
      |> put_diff("density", state.density, defaults.density)
      |> put_size(state.page_size, defaults.page_size)
      |> put_dates(state, defaults)
      |> put_present("tag", state.tag)
      |> put_present("type", state.type)
      |> put_page(page)
      |> Enum.reverse()

    case URI.encode_query(query) do
      "" -> "/feed"
      qs -> "/feed?" <> qs
    end
  end

  defp put_diff(acc, _key, value, value), do: acc
  defp put_diff(acc, key, value, _default), do: [{key, value} | acc]

  defp put_size(acc, size, size), do: acc
  defp put_size(acc, :all, _default), do: [{"size", "all"} | acc]
  defp put_size(acc, size, _default), do: [{"size", Integer.to_string(size)} | acc]

  defp put_dates(acc, state, defaults) do
    cond do
      state.from || state.to ->
        if state.from != defaults.from or state.to != defaults.to do
          acc
          |> put_present("from", state.from)
          |> put_present("to", state.to)
        else
          acc
        end

      state.days ->
        put_diff(acc, "days", state.days, defaults.days) |> stringify_days()

      defaults.from || defaults.to || defaults.days ->
        # Explicit "no date", overriding a persisted default.
        [{"days", "any"} | acc]

      true ->
        acc
    end
  end

  defp stringify_days([{"days", days} | rest]) when is_integer(days),
    do: [{"days", Integer.to_string(days)} | rest]

  defp stringify_days(acc), do: acc

  defp put_present(acc, _key, nil), do: acc
  defp put_present(acc, _key, ""), do: acc
  defp put_present(acc, key, value), do: [{key, value} | acc]

  defp put_page(acc, page) when is_integer(page) and page > 1,
    do: [{"page", Integer.to_string(page)} | acc]

  defp put_page(acc, _page), do: acc
end
