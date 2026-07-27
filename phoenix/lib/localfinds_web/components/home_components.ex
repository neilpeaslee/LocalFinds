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
end
