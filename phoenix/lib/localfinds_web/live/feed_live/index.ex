defmodule LocalfindsWeb.FeedLive.Index do
  @moduledoc """
  The feed — faithful port of apps/web/src/app/feed/page.tsx.

  Filters, page size, density and sort resolve as URL param > cookie default >
  hardcoded default (`LocalfindsWeb.FeedURL.resolve/2`). Every link is built by
  `FeedURL.href/3`, which emits only what differs from the persisted defaults.

  The reference also performs a write on render (`markFindsShown`, flipping
  `new` -> `shown`). That is deliberately NOT ported: read state belongs to a
  user and arrives with per-user customization. See spec decision 3. As a
  result this page's read path performs no writes at all.
  """
  use LocalfindsWeb, :live_view

  alias Localfinds.FeedSettings
  alias Localfinds.Finds
  alias LocalfindsWeb.FeedComponents
  alias LocalfindsWeb.FeedURL
  alias LocalfindsWeb.LiveDB
  alias LocalfindsWeb.Pagination
  alias LocalfindsWeb.Realtime
  alias LocalfindsWeb.UserAuth

  @empty_page %{rows: [], total: 0, page: 1, page_count: 1}

  @impl true
  def mount(_params, session, socket) do
    socket = if connected?(socket), do: Realtime.subscribe(socket), else: socket

    {:ok,
     socket
     |> assign(:page_title, "Feed")
     |> assign(:defaults, FeedSettings.from_cookie(session["lf_settings"]))
     |> assign(:steward?, UserAuth.steward?(socket.assigns[:current_scope]))
     |> LiveDB.load(:tags, &Finds.list_active_tags/0, [])
     |> LiveDB.load(:types, &Finds.list_find_types/0, [])}
  end

  @impl true
  def handle_params(params, _uri, socket) do
    resolved = FeedURL.resolve(params, socket.assigns.defaults)
    {:noreply, socket |> assign(:resolved, resolved) |> load_feed()}
  end

  # The single read. Called on every patch and, in Task 8, after every write —
  # so the total, the pager and "a hidden find leaves the list" all stay correct.
  defp load_feed(socket) do
    resolved = socket.assigns.resolved
    LiveDB.load(socket, :feed, fn -> Finds.feed_page(resolved) end, @empty_page)
  end

  @impl true
  def handle_event("apply_range", %{"from" => from, "to" => to}, socket) do
    to_path =
      href(socket.assigns.resolved, socket.assigns.defaults, %{
        from: FeedSettings.valid_date(from),
        to: FeedSettings.valid_date(to),
        days: nil
      })

    {:noreply, push_patch(socket, to: to_path)}
  end

  def handle_event("clear_range", _params, socket) do
    to_path =
      href(socket.assigns.resolved, socket.assigns.defaults, %{from: nil, to: nil, days: nil})

    {:noreply, push_patch(socket, to: to_path)}
  end

  def handle_event("feedback", %{"id" => raw_id, "action" => action}, socket) do
    with_steward(socket, fn ->
      case Integer.parse(to_string(raw_id)) do
        {find_id, ""} -> Finds.record_feedback(find_id, action)
        _ -> {:error, :invalid_id}
      end
    end)
  end

  def handle_event("bulk", %{"status" => status}, socket) do
    ids = Enum.map(socket.assigns.feed.rows, & &1.id)
    with_steward(socket, fn -> Finds.update_statuses(ids, status) end)
  end

  def handle_event("unhide_all", _params, socket) do
    with_steward(socket, fn -> Finds.unhide_all() end)
  end

  # The gate. The templates hide write controls from non-stewards, but hiding is
  # cosmetic: a socket frame can be sent by hand, so every write re-checks here.
  # Wrapped in DB.guard/1 so a Postgres bounce degrades to a flash rather than
  # killing the LiveView process.
  defp with_steward(socket, fun) do
    if socket.assigns.steward? do
      case Localfinds.DB.guard(fun) do
        {:ok, _result} ->
          {:noreply, load_feed(socket)}

        {:error, :database_unavailable} ->
          {:noreply,
           put_flash(socket, :error, "Temporarily unavailable — try again in a moment.")}
      end
    else
      {:noreply, put_flash(socket, :error, "Log in as a steward to do that.")}
    end
  end

  # Dormant realtime seam (rung 4 lights this up).
  @impl true
  def handle_info({:realtime, _}, socket), do: {:noreply, socket}

  # Takes the two values rather than the socket, so the template can call it too.
  defp href(resolved, defaults, patch, page \\ nil) do
    state =
      resolved
      |> Map.take([:view, :days, :from, :to, :tag, :type, :page_size, :density, :sort])
      |> Map.merge(patch)

    FeedURL.href(state, defaults, page)
  end

  defp count_line(%{page_size: :all}, feed),
    do: "#{feed.total} #{if feed.total == 1, do: "find", else: "finds"}"

  defp count_line(resolved, feed) do
    start = (feed.page - 1) * resolved.page_size
    "Showing #{start + 1}–#{start + length(feed.rows)} of #{feed.total} finds"
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.flash_group flash={@flash} />

    <.db_unavailable :if={@db_unavailable} />

    <div :if={!@db_unavailable} class="flex flex-col gap-4">
      <FeedComponents.settings_panel :if={@steward?} defaults={@defaults} />

      <FeedComponents.filter_bar
        resolved={@resolved}
        defaults={@defaults}
        tags={@tags}
        types={@types}
      />

      <p :if={@feed.rows == []} class="py-12 text-center text-sm text-stone-500">
        Nothing here. Try adjusting the filters, or check back soon.
      </p>

      <div :if={@feed.rows != []} class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-stone-500">{count_line(@resolved, @feed)}</p>

        <div :if={@steward?} class="flex items-center gap-1.5">
          <button
            :if={@resolved.view == "hidden"}
            type="button"
            phx-click="unhide_all"
            class={FeedComponents.bulk_button_class()}
          >
            Unhide all
          </button>
          <button
            :if={@resolved.view != "hidden"}
            type="button"
            phx-click="bulk"
            phx-value-status="starred"
            class={FeedComponents.bulk_button_class()}
          >
            Star page
          </button>
          <button
            :if={@resolved.view != "hidden"}
            type="button"
            phx-click="bulk"
            phx-value-status="hidden"
            class={FeedComponents.bulk_button_class()}
          >
            Hide page
          </button>
        </div>
      </div>

      <div :if={@feed.rows != []} class="flex flex-col gap-3">
        <FeedComponents.find_card
          :for={find <- @feed.rows}
          find={find}
          density={@resolved.density}
          steward?={@steward?}
        />
      </div>

      <nav
        :if={@resolved.page_size != :all and @feed.page_count > 1}
        class="flex flex-wrap items-center justify-center gap-1.5 pt-2"
      >
        <.link
          :if={@feed.page > 1}
          patch={href(@resolved, @defaults, %{}, @feed.page - 1)}
          class={FeedComponents.pill(false)}
          aria-label="Previous page"
        >
          ‹
        </.link>
        <span :if={@feed.page <= 1} class={FeedComponents.pill(false) <> " opacity-40"} aria-hidden="true">
          ‹
        </span>

        <%= for p <- Pagination.page_window(@feed.page, @feed.page_count) do %>
          <span :if={p == :ellipsis} class="px-1 text-xs text-stone-400">…</span>
          <span :if={p == @feed.page} class={FeedComponents.pill(true)} aria-current="page">{p}</span>
          <.link
            :if={p != :ellipsis and p != @feed.page}
            patch={href(@resolved, @defaults, %{}, p)}
            class={FeedComponents.pill(false)}
          >
            {p}
          </.link>
        <% end %>

        <.link
          :if={@feed.page < @feed.page_count}
          patch={href(@resolved, @defaults, %{}, @feed.page + 1)}
          class={FeedComponents.pill(false)}
          aria-label="Next page"
        >
          ›
        </.link>
        <span
          :if={@feed.page >= @feed.page_count}
          class={FeedComponents.pill(false) <> " opacity-40"}
          aria-hidden="true"
        >
          ›
        </span>
      </nav>
    </div>
    """
  end
end
