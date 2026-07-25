defmodule LocalfindsWeb.PlacesLive.Index do
  @moduledoc """
  The /places directory — faithful port of apps/web/src/app/places/page.tsx.

  Filters (town/status/tag/q) run in SQL; tier, chain visibility, ordering and
  paging are applied in memory over the result, exactly as `listPlacesRanked`
  does, because the tier comes from categories.json rather than the database.
  """
  use LocalfindsWeb, :live_view

  alias Localfinds.Categories
  alias Localfinds.Places
  alias LocalfindsWeb.Badges
  alias LocalfindsWeb.LiveDB
  alias LocalfindsWeb.Pagination
  alias LocalfindsWeb.PlaceRanking, as: Ranking
  alias LocalfindsWeb.Realtime

  @statuses ["active", "closed", "unknown"]

  @columns [{:tier, "Tier"}, {:name, "Name"}, {:kind, "Kind"}, {:town, "Town"}]

  @impl true
  def mount(_params, _session, socket) do
    socket = if connected?(socket), do: Realtime.subscribe(socket), else: socket

    {:ok,
     socket
     |> assign(:page_title, "Places")
     |> LiveDB.load(:towns, &Places.list_towns/0, [])}
  end

  @impl true
  def handle_params(params, _uri, socket) do
    cfg = Categories.load()

    town = presence(params["town"])
    status = parse_status(params["status"])
    tag = presence(params["tag"])
    q = presence(params["q"])
    tier4 = presence(params["tier4"])
    chains = presence(params["chains"])
    size = Pagination.parse_page_size(params["size"])
    page_req = Pagination.parse_page(params["page"])
    sort = Ranking.parse_sort(params["sort"])
    dir = Ranking.parse_dir(params["dir"])

    show_tier4 = tier4 == "1" or not cfg.hide_tier4
    show_chains = chains == "1" or not cfg.hide_chains

    socket =
      LiveDB.load(
        socket,
        :annotated,
        fn ->
          %{town: town, status: status, tag: tag, q: q}
          |> Places.list_directory_places()
          |> Ranking.annotate(cfg)
        end,
        []
      )

    annotated = socket.assigns.annotated
    counts = Ranking.counts(annotated)

    ordered =
      annotated
      |> Ranking.visible(show_tier4, show_chains)
      |> Ranking.sort(sort, dir)

    matched = length(ordered)
    {rows, page, page_count, start} = paginate(ordered, matched, size, page_req)

    state = %{
      town: town,
      status: status,
      tag: tag,
      q: q,
      tier4: tier4,
      chains: chains,
      size: size,
      sort: sort,
      dir: dir
    }

    {:noreply,
     assign(socket,
       state: state,
       town: town,
       status: status,
       tag: tag,
       q: q,
       size: size,
       sort: sort,
       dir: dir,
       show_tier4: show_tier4,
       show_chains: show_chains,
       rows: rows,
       matched: matched,
       total: length(annotated),
       page: page,
       page_count: page_count,
       start: start,
       tier4_count: counts.tier4,
       chain_count: counts.chain,
       has_filters: !is_nil(town) or !is_nil(status) or !is_nil(tag) or !is_nil(q),
       # `annotated` is consumed only above (counts/visible/sort/total) and never
       # read by the template — dropping it here keeps a 5000-row DirectoryPlace
       # list (with decoded jsonb tags) from sitting in socket assigns for the
       # life of the connection. LiveDB.load re-assigns it fresh on every
       # handle_params, so nil-ing it here is not a cache, just cleanup.
       annotated: nil
     )}
  end

  # Search submit → fold the term into the URL so the state stays shareable.
  @impl true
  def handle_event("search", %{"q" => q}, socket) do
    {:noreply, push_patch(socket, to: places_path(socket.assigns.state, %{q: presence(q)}))}
  end

  # Dormant realtime seam (rung 4 lights this up).
  @impl true
  def handle_info({:realtime, _}, socket), do: {:noreply, socket}

  defp paginate(ordered, _matched, :all, _page_req), do: {ordered, 1, 1, 0}

  defp paginate(ordered, matched, size, page_req) do
    window = Pagination.resolve_page(matched, page_req, size)
    {Enum.slice(ordered, window.start, size), window.page, window.page_count, window.start}
  end

  defp presence(nil), do: nil

  defp presence(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp parse_status(raw) when raw in @statuses, do: raw
  defp parse_status(_), do: nil

  defp statuses, do: @statuses
  defp columns, do: @columns

  # Merge a patch onto the current query and drop defaults, so URLs stay short —
  # the Elixir counterpart of hrefWith(). `page` is deliberately absent from
  # `current`: every filter, size and sort link resets to page 1, and only the
  # numbered pager re-adds it.
  defp places_path(state, patch) do
    current = %{
      "town" => state.town,
      "status" => state.status,
      "tag" => state.tag,
      "q" => state.q,
      "tier4" => state.tier4,
      "chains" => state.chains,
      "size" => size_param(state.size),
      "sort" => state.sort && Atom.to_string(state.sort),
      "dir" => if(state.dir == :asc, do: nil, else: "desc")
    }

    query =
      current
      |> Map.merge(Map.new(patch, fn {k, v} -> {to_string(k), v} end))
      |> Enum.reject(fn {_k, v} -> v in [nil, ""] end)
      |> Enum.sort()

    if query == [], do: ~p"/places", else: ~p"/places?#{query}"
  end

  defp header_patch(state, key) do
    next_dir = if state.sort == key and state.dir == :asc, do: :desc, else: :asc

    places_path(state, %{
      sort: Atom.to_string(key),
      dir: if(next_dir == :asc, do: nil, else: "desc")
    })
  end

  # 50 is the default, so it stays implicit in the URL.
  defp size_param(50), do: nil
  defp size_param(:all), do: "all"
  defp size_param(size), do: Integer.to_string(size)

  # osm ids carry their own slash ("node/1"), which is why the route is a glob
  # and the id is interpolated as a LIST — ~p encodes a list as path segments,
  # where a bare string would percent-encode the slash into %2F.
  defp place_path(osm_id), do: ~p"/places/#{String.split(osm_id, "/")}"

  defp pill(active?) do
    base = "rounded px-2 py-0.5 text-xs "

    base <>
      if active?,
        do: "bg-stone-800 text-white",
        else: "bg-stone-100 text-stone-600 hover:bg-stone-200"
  end

  defp arrow(:asc), do: "▲"
  defp arrow(:desc), do: "▼"

  defp aria_sort(sort, _dir, key) when sort != key, do: "none"
  defp aria_sort(_sort, :asc, _key), do: "ascending"
  defp aria_sort(_sort, :desc, _key), do: "descending"

  defp order_label(nil, _dir), do: "ranked by search priority"

  defp order_label(:tier, dir),
    do: "sorted by tier (#{if dir == :asc, do: "Tier 1 → 4", else: "Tier 4 → 1"})"

  defp order_label(sort, dir),
    do: "sorted by #{sort} (#{if dir == :asc, do: "A–Z", else: "Z–A"})"

  defp count_line(assigns) do
    %{size: size, matched: matched, rows: rows, start: start} = assigns

    if size == :all or matched == 0 do
      "#{matched} #{if matched == 1, do: "place", else: "places"}"
    else
      "Showing #{start + 1}–#{start + length(rows)} of #{matched} places"
    end
  end

  @impl true
  def render(assigns) do
    ~H"""
    <.db_unavailable :if={@db_unavailable} />

    <p
      :if={!@db_unavailable and @total == 0 and !@has_filters}
      class="py-12 text-center text-sm text-stone-500"
    >
      No places yet. The directory is built from the OpenStreetMap
      <code class="rounded bg-stone-100 px-1">osm_places</code>
      materialized view, refreshed daily.
    </p>

    <div
      :if={!@db_unavailable and (@total > 0 or @has_filters)}
      class="flex flex-col gap-4"
    >
      <div class="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3">
        <form phx-submit="search" class="flex gap-2">
          <input
            type="search"
            name="q"
            value={@q}
            placeholder="Search by name…"
            class="flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <button type="submit" class="rounded bg-stone-800 px-3 py-1 text-sm text-white">
            Search
          </button>
        </form>

        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-xs font-medium text-stone-500">Status</span>
          <.link patch={places_path(@state, %{status: nil})} class={pill(is_nil(@status))}>
            all
          </.link>
          <.link
            :for={s <- statuses()}
            patch={places_path(@state, %{status: s})}
            class={pill(@status == s)}
          >
            {s}
          </.link>
        </div>

        <div :if={@towns != []} class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-xs font-medium text-stone-500">Town</span>
          <.link patch={places_path(@state, %{town: nil})} class={pill(is_nil(@town))}>all</.link>
          <.link
            :for={t <- @towns}
            patch={places_path(@state, %{town: t.town})}
            class={pill(@town == t.town)}
          >
            {t.town} <span class="opacity-60">{t.n}</span>
          </.link>
        </div>

        <div
          :if={@chain_count > 0 or @tier4_count > 0}
          class="flex flex-wrap items-center gap-1.5"
        >
          <span class="mr-1 text-xs font-medium text-stone-500">Show</span>
          <.link
            :if={@chain_count > 0}
            patch={places_path(@state, %{chains: if(@show_chains, do: nil, else: "1")})}
            class={pill(@show_chains)}
          >
            chains ({@chain_count})
          </.link>
          <.link
            :if={@tier4_count > 0}
            patch={places_path(@state, %{tier4: if(@show_tier4, do: nil, else: "1")})}
            class={pill(@show_tier4)}
          >
            excluded categories ({@tier4_count})
          </.link>
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-xs font-medium text-stone-500">Per page</span>
          <.link
            :for={s <- Pagination.page_sizes()}
            patch={places_path(@state, %{size: size_param(s)})}
            class={pill(@size == s)}
          >
            {if(s == :all, do: "All", else: s)}
          </.link>
        </div>

        <div :if={@tag} class="text-xs text-stone-500">
          Tag: <span class="font-medium">{@tag}</span>
          <.link patch={places_path(@state, %{tag: nil})} class="text-blue-700 hover:underline">
            clear
          </.link>
        </div>
      </div>

      <p class="text-xs text-stone-500">
        {count_line(assigns)}{if(@has_filters, do: " matching filters", else: "")}, {order_label(
          @sort,
          @dir
        )}
      </p>

      <p :if={@matched == 0} class="py-8 text-center text-sm text-stone-500">
        No places match these filters.
      </p>

      <div
        :if={@matched > 0}
        class="overflow-hidden rounded-lg border border-stone-200 bg-white"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-stone-200 text-xs text-stone-500">
              <th
                :for={{key, label} <- columns()}
                scope="col"
                aria-sort={aria_sort(@sort, @dir, key)}
                class="px-3 py-2 text-left font-medium"
              >
                <.link
                  patch={header_patch(@state, key)}
                  class="inline-flex items-center gap-1 hover:text-stone-900"
                >
                  {label}
                  <span :if={@sort == key} aria-hidden="true">{arrow(@dir)}</span>
                </.link>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr :for={r <- @rows} class="border-b border-stone-100 last:border-0">
              <td class="px-3 py-2">
                <span
                  class={"rounded px-1.5 py-0.5 text-xs font-medium " <> Badges.tier(r.tier)}
                  title="Search-priority tier"
                >
                  T{r.tier}
                </span>
              </td>
              <td class="px-3 py-2">
                <.link
                  navigate={place_path(r.place.osm_id)}
                  class="font-medium text-stone-900 hover:underline"
                >
                  {r.place.name}
                </.link>
                <span
                  :if={r.is_chain}
                  class="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
                  title="National/regional chain (OSM brand)"
                >
                  chain{if(r.place.brand, do: ": " <> r.place.brand, else: "")}
                </span>
                <a
                  :if={r.place.website}
                  href={r.place.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="ml-1.5 text-xs text-blue-700 hover:underline"
                  title={r.place.website}
                  aria-label={"Visit #{r.place.name} website (opens in a new tab)"}
                >
                  ↗
                </a>
              </td>
              <td class="px-3 py-2 text-stone-600">{r.place.kind || "—"}</td>
              <td class="px-3 py-2 text-stone-500">{r.place.town || "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <nav
        :if={@size != :all and @page_count > 1}
        class="flex flex-wrap items-center justify-center gap-1.5 pt-2"
      >
        <.link
          :if={@page > 1}
          patch={places_path(@state, %{page: Integer.to_string(@page - 1)})}
          class={pill(false)}
          aria-label="Previous page"
        >
          ‹
        </.link>
        <span :if={@page <= 1} class={pill(false) <> " opacity-40"} aria-hidden="true">‹</span>

        <%= for p <- Pagination.page_window(@page, @page_count) do %>
          <span :if={p == :ellipsis} class="px-1 text-xs text-stone-400">…</span>
          <span :if={p == @page} class={pill(true)} aria-current="page">{p}</span>
          <.link
            :if={p != :ellipsis and p != @page}
            patch={places_path(@state, %{page: Integer.to_string(p)})}
            class={pill(false)}
          >
            {p}
          </.link>
        <% end %>

        <.link
          :if={@page < @page_count}
          patch={places_path(@state, %{page: Integer.to_string(@page + 1)})}
          class={pill(false)}
          aria-label="Next page"
        >
          ›
        </.link>
        <span :if={@page >= @page_count} class={pill(false) <> " opacity-40"} aria-hidden="true">
          ›
        </span>
      </nav>
    </div>
    """
  end
end
