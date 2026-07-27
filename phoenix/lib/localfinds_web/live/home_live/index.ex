defmodule LocalfindsWeb.HomeLive.Index do
  @moduledoc """
  The dashboard — port of `apps/web/src/app/page.tsx`.

  Deliberately sets no `page_title`: the reference's home page has no
  page-specific title either, so the layout's default applies.
  """
  use LocalfindsWeb, :live_view

  alias Localfinds.Finds
  alias Localfinds.Markdown
  alias Localfinds.Places
  alias Localfinds.Region
  alias Localfinds.Towns
  alias LocalfindsWeb.HomeComponents
  alias LocalfindsWeb.LiveDB
  alias LocalfindsWeb.Realtime

  @compact_finds 6
  @empty_feed %{rows: [], total: 0, page: 1, page_count: 1}

  @impl true
  def mount(_params, _session, socket) do
    socket = if connected?(socket), do: Realtime.subscribe(socket), else: socket

    socket =
      socket
      |> assign(:region_name, Region.name() || "Your region")
      |> assign(:coverage, Markdown.to_html(Region.coverage()))
      # Towns is read unconditionally, unlike the other map config: it also
      # feeds the "towns covered" stat, which renders without the map.
      |> assign(:towns, Towns.load())
      |> LiveDB.load(:place_count, &Places.count_places/0, 0)
      |> LiveDB.load(:feed, fn -> Finds.feed_page(%{view: "default"}) end, @empty_feed)

    {:ok, socket}
  end

  # Dormant realtime seam (rung 4 lights this up).
  @impl true
  def handle_info({:realtime, _}, socket), do: {:noreply, socket}

  @impl true
  def render(assigns) do
    ~H"""
    <div class="flex flex-col gap-6">
      <%!-- Task 8 replaces this block with the real map container. --%>
      <div class="flex h-72 w-full items-center justify-center rounded-lg border border-stone-200 bg-stone-100 text-sm text-stone-400 sm:h-96">
        Loading map…
      </div>

      <.db_unavailable :if={@db_unavailable} />

      <section :if={!@db_unavailable}>
        <h1 class="text-xl font-semibold tracking-tight">{@region_name}</h1>

        <div :if={@coverage} class="prose prose-sm prose-stone mt-2 max-w-none">
          {@coverage}
        </div>

        <dl class="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-stone-600">
          <HomeComponents.stat label="towns covered" value={length(@towns)} />
          <HomeComponents.stat label="places catalogued" value={@place_count} />
          <HomeComponents.stat label="current finds" value={@feed.total} />
        </dl>
      </section>

      <section :if={!@db_unavailable}>
        <div class="mb-3 flex items-baseline justify-between">
          <h2 class="text-lg font-semibold tracking-tight">Current finds</h2>
          <a href="/feed" class="text-sm text-blue-700 hover:underline">View all →</a>
        </div>

        <p :if={@feed.rows == []} class="py-8 text-center text-sm text-stone-500">
          No current finds right now.
        </p>

        <div :if={@feed.rows != []} class="grid gap-3 sm:grid-cols-2">
          <HomeComponents.compact_find_card
            :for={find <- Enum.take(@feed.rows, compact_finds())}
            find={find}
          />
        </div>
      </section>
    </div>
    """
  end

  # `@compact_finds` cannot be referenced directly inside `~H`: HEEx treats a
  # leading `@` as assigns sugar (`assigns.compact_finds`), not module-attribute
  # access, so the template would look for a `:compact_finds` assign that is
  # never set and raise `KeyError`. Mirrors the `defp statuses, do: @statuses`
  # accessor pattern in `PlacesLive.Index`.
  defp compact_finds, do: @compact_finds
end
