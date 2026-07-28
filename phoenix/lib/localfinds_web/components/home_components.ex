defmodule LocalfindsWeb.HomeComponents do
  @moduledoc """
  The dashboard's own components — port of `CompactFindCard.tsx` and the local
  `Stat` function in `apps/web/src/app/page.tsx`.

  `compact_find_card/1` is deliberately NOT the existing
  `FeedComponents.find_card/1` with `density="compact"`. They differ in what
  they are for: the feed's compact card keeps the action row and drops the
  summary, because acting on finds is what /feed is; the dashboard's card is a
  read-only window onto what's current, so it keeps the summary and has no
  actions at all.
  """
  use Phoenix.Component

  alias LocalfindsWeb.Format

  attr :label, :string, required: true
  attr :value, :integer, required: true

  def stat(assigns) do
    ~H"""
    <div class="flex items-baseline gap-1.5">
      <span class="text-base font-semibold text-stone-900">{@value}</span>
      <span>{@label}</span>
    </div>
    """
  end

  attr :find, :map, required: true

  def compact_find_card(assigns) do
    assigns =
      assign(assigns,
        event_start: Format.short_month_day(assigns.find.event_start),
        tags: Enum.take(assigns.find.tags, 2)
      )

    ~H"""
    <article class="rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
      <h3 class="text-sm font-medium leading-snug">
        <a
          :if={@find.url}
          href={@find.url}
          target="_blank"
          rel="noopener noreferrer"
          class="text-blue-700 hover:underline"
        >
          {@find.title}
        </a>
        <span :if={!@find.url}>{@find.title}</span>
      </h3>

      <p :if={@find.summary} class="mt-1 line-clamp-2 text-xs text-stone-600">
        {@find.summary}
      </p>

      <div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
        <span
          :if={@find.type != "event"}
          class="rounded bg-emerald-100 px-1.5 py-0.5 font-medium capitalize text-emerald-800"
        >
          {@find.type}
        </span>
        <span :if={@event_start} class="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
          {@event_start}
        </span>
        <span :for={tag <- @tags} class="rounded bg-stone-100 px-1.5 py-0.5">{tag}</span>
        <span class="ml-auto whitespace-nowrap">via {@find.agent}</span>
      </div>
    </article>
    """
  end

  attr :connected?, :boolean, required: true
  attr :towns, :list, default: []
  attr :boundaries, :list, default: []
  attr :themes, :list, default: []

  @doc """
  The map container.

  Renders the placeholder until the socket connects, which mirrors the
  reference's `next/dynamic(..., {ssr: false, loading: …})`: Leaflet touches the
  DOM at import time and cannot server-render either way.

  Pins are deliberately NOT a `data-*` attribute here — at ~20k rows they were
  the ~3.7MB payload that delayed the connected mount's first ping past
  Phoenix's websocket-fallback timeout (see `HomeLive.Index`). `towns`,
  `boundaries` and `themes` stay attributes because they're small (a handful
  of rows each) and `RegionMap`'s `mounted()` needs them immediately to draw
  tiles/outlines/legend; pins arrive afterward via `push_event/3`, and the
  hook picks them up in a `handleEvent("pins", ...)` callback instead of
  `mounted()`.

  `phx-update="ignore"` is load-bearing: everything inside this div belongs to
  Leaflet, and a LiveView patch would destroy it.
  """
  def region_map(assigns) do
    ~H"""
    <div
      :if={!@connected?}
      class="flex h-72 w-full items-center justify-center rounded-lg border border-stone-200 bg-stone-100 text-sm text-stone-400 sm:h-96"
    >
      Loading map…
    </div>

    <div :if={@connected?} class="relative h-72 w-full sm:h-96">
      <div
        id="region-map"
        phx-hook="RegionMap"
        phx-update="ignore"
        class="h-full w-full overflow-hidden rounded-lg border border-stone-200"
        data-towns={Jason.encode!(@towns)}
        data-boundaries={Jason.encode!(@boundaries)}
        data-themes={Jason.encode!(@themes)}
      >
      </div>

      <div class="absolute top-3 right-3 z-[1000] max-w-[10rem] rounded-md border border-stone-200 bg-white/95 p-2 text-xs text-stone-700 shadow-sm">
        <div class="mb-1 flex items-center gap-1.5">
          <span class="inline-block h-3 w-3 rounded-sm border-2" style="border-color: #b45309"></span>
          <span>Coverage area</span>
        </div>
        <div :for={theme <- @themes} class="flex items-center gap-1.5">
          <span
            class="inline-block h-2.5 w-2.5 rounded-full"
            style={"background-color: #{theme.color}"}
          >
          </span>
          <span>{theme.label}</span>
        </div>
        <div class="mt-1 flex items-center gap-1.5">
          <span class="inline-block h-2.5 w-2.5 rounded-full" style="background-color: #64748b"></span>
          <span>more (zoom in)</span>
        </div>
      </div>
    </div>
    """
  end
end
