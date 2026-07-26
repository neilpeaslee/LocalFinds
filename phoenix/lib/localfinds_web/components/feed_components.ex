defmodule LocalfindsWeb.FeedComponents do
  @moduledoc """
  The feed's HEEx components — ports of `FindCard`, `FilterBar` and
  `DateRangePicker`.

  Write controls live inside `find_card/1` behind `@steward?`. Hiding them is
  cosmetic; `FeedLive.Index` re-checks the scope in every write handler, because
  a socket frame can be sent by hand.
  """
  use LocalfindsWeb, :html

  alias LocalfindsWeb.FeedURL
  alias LocalfindsWeb.Format
  alias LocalfindsWeb.Pagination

  @views [
    {"default", "All current"},
    {"starred", "Starred"},
    {"hidden", "Hidden"},
    {"all", "Everything"}
  ]
  @windows [{1, "24h"}, {7, "7d"}, {30, "30d"}]
  @sorts [{"newest", "Newest"}, {"oldest", "Oldest"}, {"soonest", "Soonest"}]
  @densities [{"full", "Full"}, {"compact", "Compact"}]

  @doc "Filter chip: rounded-full, ring when inactive. Distinct from the pager pill."
  def chip(active?) do
    base = "rounded-full px-2.5 py-0.5 text-xs "

    base <>
      if active?,
        do: "bg-stone-800 text-white",
        else: "bg-white text-stone-600 ring-1 ring-stone-200 hover:bg-stone-100"
  end

  @doc "Pager pill — square corners, no ring."
  def pill(active?) do
    base = "rounded px-2 py-0.5 text-xs "

    base <>
      if active?,
        do: "bg-stone-800 text-white",
        else: "bg-stone-100 text-stone-600 hover:bg-stone-200"
  end

  def bulk_button_class,
    do: "rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-200"

  attr :resolved, :map, required: true
  attr :defaults, :map, required: true
  attr :tags, :list, required: true
  attr :types, :list, required: true

  def filter_bar(assigns) do
    assigns =
      assign(assigns,
        views: @views,
        windows: @windows,
        sorts: @sorts,
        densities: @densities,
        range_active?: !is_nil(assigns.resolved.from) or !is_nil(assigns.resolved.to)
      )

    ~H"""
    <div class="mb-4 flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-1.5">
        <.link
          :for={{view, label} <- @views}
          patch={href(@resolved, @defaults, %{view: view})}
          class={chip(@resolved.view == view)}
        >
          {label}
        </.link>
        <span class="mx-1 text-stone-300">|</span>
        <.link
          patch={href(@resolved, @defaults, %{days: nil, from: nil, to: nil})}
          class={chip(is_nil(@resolved.days) and not @range_active?)}
        >
          Any time
        </.link>
        <.link
          :for={{days, label} <- @windows}
          patch={href(@resolved, @defaults, %{days: days, from: nil, to: nil})}
          class={chip(@resolved.days == days)}
        >
          {label}
        </.link>
      </div>

      <.date_range from={@resolved.from} to={@resolved.to} />

      <div class="flex flex-wrap items-center gap-1.5">
        <span class="mr-1 text-xs font-medium text-stone-500">Per page</span>
        <.link
          :for={size <- Pagination.page_sizes()}
          patch={href(@resolved, @defaults, %{page_size: size})}
          class={chip(@resolved.page_size == size)}
        >
          {if(size == :all, do: "All", else: size)}
        </.link>
        <span class="mx-1 text-stone-300">|</span>
        <span class="mr-1 text-xs font-medium text-stone-500">Sort</span>
        <.link
          :for={{sort, label} <- @sorts}
          patch={href(@resolved, @defaults, %{sort: sort})}
          class={chip(@resolved.sort == sort)}
        >
          {label}
        </.link>
        <span class="mx-1 text-stone-300">|</span>
        <span class="mr-1 text-xs font-medium text-stone-500">Cards</span>
        <.link
          :for={{density, label} <- @densities}
          patch={href(@resolved, @defaults, %{density: density})}
          class={chip(@resolved.density == density)}
        >
          {label}
        </.link>
      </div>

      <div :if={length(@types) > 1} class="flex flex-wrap items-center gap-1.5">
        <span class="mr-1 text-xs font-medium text-stone-500">Type</span>
        <.link patch={href(@resolved, @defaults, %{type: nil})} class={chip(is_nil(@resolved.type))}>
          All
        </.link>
        <.link
          :for={type <- @types}
          patch={href(@resolved, @defaults, %{type: type})}
          class={chip(@resolved.type == type)}
        >
          {String.capitalize(type)}
        </.link>
      </div>

      <div :if={@tags != []} class="flex flex-wrap items-center gap-1.5">
        <.link
          :if={@resolved.tag}
          patch={href(@resolved, @defaults, %{tag: nil})}
          class={chip(true)}
        >
          ✕ {@resolved.tag}
        </.link>
        <.link
          :for={tag <- @tags |> Enum.reject(&(&1 == @resolved.tag)) |> Enum.take(12)}
          patch={href(@resolved, @defaults, %{tag: tag})}
          class={chip(false)}
        >
          {tag}
        </.link>
      </div>
    </div>
    """
  end

  attr :from, :string, default: nil
  attr :to, :string, default: nil

  def date_range(assigns) do
    ~H"""
    <form phx-submit="apply_range" class="flex flex-wrap items-center gap-1.5 text-xs text-stone-600">
      <span class="mr-1 font-medium text-stone-500">Event dates</span>
      <input
        type="date"
        name="from"
        value={@from}
        aria-label="Events from"
        class="rounded border border-stone-300 px-1.5 py-0.5"
      />
      <span aria-hidden="true">→</span>
      <input
        type="date"
        name="to"
        value={@to}
        aria-label="Events to"
        class="rounded border border-stone-300 px-1.5 py-0.5"
      />
      <button type="submit" class="rounded bg-stone-800 px-2 py-0.5 text-white">Apply</button>
      <button
        :if={@from || @to}
        type="button"
        phx-click="clear_range"
        class="rounded bg-stone-100 px-2 py-0.5 text-stone-600 hover:bg-stone-200"
      >
        Clear
      </button>
    </form>
    """
  end

  attr :find, :map, required: true
  attr :density, :string, default: "full"
  attr :steward?, :boolean, default: false

  def find_card(assigns) do
    compact = assigns.density == "compact"

    assigns =
      assign(assigns,
        compact: compact,
        event_start: Format.medium_date(assigns.find.event_start),
        event_end: Format.medium_date(assigns.find.event_end),
        discovered: Format.medium_date(assigns.find.discovered_at),
        # Compact trades the summary and most tags for vertical density; the
        # action row stays — it is what distinguishes the feed from the dashboard.
        tags: if(compact, do: Enum.take(assigns.find.tags, 3), else: assigns.find.tags)
      )

    ~H"""
    <article class={"rounded-lg border border-stone-200 bg-white shadow-sm " <> if(@compact, do: "p-3", else: "p-4")}>
      <h2 class={"font-medium leading-snug " <> if(@compact, do: "text-sm", else: "")}>
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
      </h2>

      <p :if={@find.summary && !@compact} class="mt-1 text-sm text-stone-600">{@find.summary}</p>

      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <span
          :if={@find.type != "event"}
          class="rounded bg-emerald-100 px-1.5 py-0.5 font-medium capitalize text-emerald-800"
        >
          {@find.type}{if @find.score, do: " · fit #{round(@find.score * 100)}%", else: ""}
        </span>
        <.link
          :if={@find.place_osm_id}
          navigate={~p"/places/#{String.split(@find.place_osm_id, "/")}"}
          class="rounded bg-stone-100 px-1.5 py-0.5 hover:bg-stone-200"
        >
          Place ↗
        </.link>
        <span
          :if={@event_start}
          class="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800"
        >
          {@event_start}{if @event_end && @event_end != @event_start, do: " – #{@event_end}", else: ""}
        </span>
        <span :for={tag <- @tags} class="rounded bg-stone-100 px-1.5 py-0.5">{tag}</span>
        <span class="ml-auto">
          via {@find.agent}{if @discovered, do: " · #{@discovered}", else: ""}
        </span>
      </div>

      <div :if={@steward?} class="mt-2 flex items-center gap-1 border-t border-stone-100 pt-2">
        <%!-- Thumbs toggle: clicking an already-active thumb sends "thumbs_clear"
        instead of repeating the same thumb, so the click un-thumbs the find.
        record_feedback/2 appends the retraction rather than deleting the
        earlier row (localfinds.feedback is append-only), and
        Finds.feed_page/1's lateral join then reports no active thumb. --%>
        <.action_button
          find_id={@find.id}
          action={if @find.thumb == "thumbs_up", do: "thumbs_clear", else: "thumbs_up"}
          label="👍"
          title="More like this"
          active={@find.thumb == "thumbs_up"}
        />
        <.action_button
          find_id={@find.id}
          action={if @find.thumb == "thumbs_down", do: "thumbs_clear", else: "thumbs_down"}
          label="👎"
          title="Less like this"
          active={@find.thumb == "thumbs_down"}
        />
        <.action_button
          :if={@find.status == "starred"}
          find_id={@find.id}
          action="unstar"
          label="★ Starred"
          title="Remove star"
          active
        />
        <.action_button
          :if={@find.status != "starred"}
          find_id={@find.id}
          action="star"
          label="☆ Star"
          title="Star this find"
        />
        <.action_button
          :if={@find.status == "hidden"}
          find_id={@find.id}
          action="unhide"
          label="Unhide"
          title="Restore to feed"
        />
        <.action_button
          :if={@find.status != "hidden"}
          find_id={@find.id}
          action="hide"
          label="Hide"
          title="Hide from feed"
        />
      </div>
    </article>
    """
  end

  attr :find_id, :integer, required: true
  attr :action, :string, required: true
  attr :label, :string, required: true
  attr :title, :string, required: true
  attr :active, :boolean, default: false

  defp action_button(assigns) do
    ~H"""
    <button
      type="button"
      phx-click="feedback"
      phx-value-id={@find_id}
      phx-value-action={@action}
      title={@title}
      class={"rounded px-1.5 py-0.5 text-sm hover:bg-stone-100 " <> if(@active, do: "bg-amber-50", else: "")}
    >
      {@label}
    </button>
    """
  end

  attr :defaults, :map, required: true

  @doc """
  Collapsible defaults editor — port of `SettingsPanel`.

  A plain `<details>` keeps it zero-JS, and the form posts to the controller
  rather than the socket, because a LiveView cannot set a cookie. It edits the
  *persisted defaults*, not the current URL state, which is why it is seeded
  from `@defaults`.

  The reference needs a `key={formKey}` remount hack so React 19's auto-reset
  does not snap the selects back to stale values; the redirect after a save
  re-renders this page from the new cookie, so there is nothing to work around.
  """
  def settings_panel(assigns) do
    assigns =
      assign(assigns, views: @views, sorts: @sorts, densities: @densities, windows: @windows)

    ~H"""
    <details class="rounded-lg border border-stone-200 bg-white">
      <summary class="cursor-pointer px-3 py-2 text-sm font-medium text-stone-700">Settings</summary>
      <.form
        for={%{}}
        action={~p"/feed/settings"}
        method="post"
        class="flex flex-col gap-3 border-t border-stone-100 p-3"
      >
        <div class="flex flex-wrap gap-3">
          <.field label="Default view">
            <select name="view" class={select_class()}>
              <option :for={{value, label} <- @views} value={value} selected={@defaults.view == value}>
                {label}
              </option>
            </select>
          </.field>
          <.field label="Per page">
            <select name="pageSize" class={select_class()}>
              <option
                :for={size <- Pagination.page_sizes()}
                value={if(size == :all, do: "all", else: size)}
                selected={@defaults.page_size == size}
              >
                {if(size == :all, do: "All", else: size)}
              </option>
            </select>
          </.field>
          <.field label="Sort">
            <select name="sort" class={select_class()}>
              <option :for={{value, label} <- @sorts} value={value} selected={@defaults.sort == value}>
                {label}{if value == "soonest", do: " (by event date)", else: ""}
              </option>
            </select>
          </.field>
          <.field label="Cards">
            <select name="density" class={select_class()}>
              <option
                :for={{value, label} <- @densities}
                value={value}
                selected={@defaults.density == value}
              >
                {label}
              </option>
            </select>
          </.field>
          <.field label="Default time window">
            <select name="days" class={select_class()}>
              <option value="" selected={is_nil(@defaults.days)}>Any time</option>
              <option
                :for={{days, label} <- @windows}
                value={days}
                selected={@defaults.days == days}
              >
                {label}
              </option>
            </select>
          </.field>
        </div>

        <div class="flex flex-wrap items-end gap-3">
          <.field label="Default event range — from">
            <input type="date" name="from" value={@defaults.from} class={select_class()} />
          </.field>
          <.field label="to">
            <input type="date" name="to" value={@defaults.to} class={select_class()} />
          </.field>
          <button type="submit" class="rounded bg-stone-800 px-3 py-1.5 text-sm text-white">
            Save as default
          </button>
        </div>

        <p class="text-xs text-stone-500">
          These seed every visit; per-page filters still override them. A saved event range takes
          precedence over the time window.
        </p>
      </.form>
    </details>
    """
  end

  attr :label, :string, required: true
  slot :inner_block, required: true

  defp field(assigns) do
    ~H"""
    <label class="flex flex-col gap-1 text-xs">
      <span class="font-medium text-stone-500">{@label}</span>
      {render_slot(@inner_block)}
    </label>
    """
  end

  defp select_class, do: "rounded border border-stone-300 px-2 py-1 text-sm"

  # Every chip is the resolved state with one field changed; FeedURL then emits
  # only what differs from the cookie defaults.
  defp href(resolved, defaults, patch) do
    state =
      resolved
      |> Map.take([:view, :days, :from, :to, :tag, :type, :page_size, :density, :sort])
      |> Map.merge(patch)

    FeedURL.href(state, defaults)
  end
end
