defmodule LocalfindsWeb.PlacesLive.Show do
  @moduledoc """
  A single place — faithful port of apps/web/src/app/places/[...osmId]/page.tsx.
  The osm id is a glob segment because real ids contain a slash ("node/1").
  """
  use LocalfindsWeb, :live_view

  alias Localfinds.Categories
  alias Localfinds.Markdown
  alias Localfinds.Places
  alias Localfinds.Places.DirectoryPlace
  alias LocalfindsWeb.Badges
  alias LocalfindsWeb.LiveDB
  alias LocalfindsWeb.Realtime

  @impl true
  def mount(%{"osm_id" => segments}, _session, socket) do
    osm_id = Enum.join(segments, "/")
    socket = if connected?(socket), do: Realtime.subscribe(socket), else: socket
    socket = LiveDB.load(socket, :place, fn -> Places.get_directory_place(osm_id) end, nil)

    cond do
      socket.assigns.db_unavailable ->
        {:ok, assign(socket, page_title: "Places", tier: nil, note: nil, tags: [])}

      is_nil(socket.assigns.place) ->
        raise LocalfindsWeb.NotFoundError, "no place with osm_id #{osm_id}"

      true ->
        place = socket.assigns.place

        {:ok,
         assign(socket,
           page_title: place.name,
           tier: Categories.tier_of(Categories.load(), place.kind),
           note: Markdown.to_html(place.annotation_note),
           tags: DirectoryPlace.tag_list(place)
         )}
    end
  end

  # Dormant realtime seam (rung 4 lights this up).
  @impl true
  def handle_info({:realtime, _}, socket), do: {:noreply, socket}

  defp chain?(%DirectoryPlace{brand: brand}), do: is_binary(brand) and brand != ""

  defp custom?(osm_id), do: String.starts_with?(osm_id, "custom/")

  @impl true
  def render(assigns) do
    ~H"""
    <.db_unavailable :if={@db_unavailable} />

    <div :if={!@db_unavailable} class="flex flex-col gap-4">
      <.link navigate={~p"/places"} class="text-xs text-blue-700 hover:underline">
        ← Back to places
      </.link>

      <div class="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span
            class={"rounded px-1.5 py-0.5 text-xs font-medium " <> Badges.tier(@tier)}
            title="Search-priority tier"
          >
            T{@tier}
          </span>
          <h2 class="text-base font-semibold">{@place.name}</h2>
          <span
            :if={@place.kind}
            class="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600"
          >
            {@place.kind}
          </span>
          <span
            :if={chain?(@place)}
            class="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
            title="National/regional chain (OSM brand)"
          >
            chain: {@place.brand}
          </span>
          <span class={"rounded px-1.5 py-0.5 text-xs " <> Badges.place_status(@place.status)}>
            {@place.status}
          </span>
          <span :if={@place.town} class="text-xs text-stone-500">{@place.town}</span>
        </div>

        <div :if={@place.address} class="text-sm text-stone-600">{@place.address}</div>

        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
          <a
            :if={@place.website}
            href={@place.website}
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-700 hover:underline"
          >
            {@place.website}
          </a>
          <span :if={@place.phone}>{@place.phone}</span>
          <span
            :if={custom?(@place.osm_id)}
            title="Added by LocalFinds — not an OpenStreetMap feature"
          >
            {@place.osm_id}
          </span>
          <a
            :if={!custom?(@place.osm_id)}
            href={"https://www.openstreetmap.org/" <> @place.osm_id}
            target="_blank"
            rel="noopener noreferrer"
            class="hover:underline"
            aria-label={"View #{@place.name} on OpenStreetMap (opens in a new tab)"}
          >
            {@place.osm_id}
          </a>
        </div>

        <div :if={@tags != []} class="flex flex-wrap gap-1">
          <.link
            :for={tag <- @tags}
            navigate={~p"/places?tag=#{tag}"}
            class="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 hover:bg-stone-200"
          >
            {tag}
          </.link>
        </div>
      </div>

      <div class="rounded-lg border border-stone-200 bg-white p-4">
        <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">Note</h3>
        <div :if={@note} class="prose prose-sm prose-stone max-w-none">{@note}</div>
        <p :if={!@note} class="text-sm text-stone-500">No note yet.</p>
      </div>
    </div>
    """
  end
end
