defmodule LocalfindsWeb.SourcesLive.Show do
  @moduledoc """
  A single source — faithful port of apps/web/src/app/sources/[id]/page.tsx.
  The site note lives in the source-keeper's workspace on disk, not the DB.
  """
  use LocalfindsWeb, :live_view

  alias Localfinds.AgentNotes
  alias Localfinds.Finds
  alias Localfinds.Markdown
  alias Localfinds.Sources
  alias LocalfindsWeb.LiveDB
  alias LocalfindsWeb.Realtime

  @status_style %{
    "active" => "bg-green-100 text-green-800",
    "paused" => "bg-stone-200 text-stone-600",
    "dead" => "bg-red-100 text-red-800"
  }

  @find_status_style %{
    "new" => "bg-blue-100 text-blue-800",
    "shown" => "bg-stone-100 text-stone-600",
    "hidden" => "bg-stone-200 text-stone-500",
    "starred" => "bg-amber-100 text-amber-800"
  }

  @impl true
  def mount(%{"id" => raw_id}, _session, socket) do
    # Integer.parse with a "" remainder mirrors the Next page's Number() rule:
    # "1abc" is not an id, so it 404s instead of silently loading source 1.
    id =
      case Integer.parse(raw_id) do
        {n, ""} when n > 0 -> n
        _ -> nil
      end

    if is_nil(id), do: raise(LocalfindsWeb.NotFoundError, "bad source id #{raw_id}")

    socket = if connected?(socket), do: Realtime.subscribe(socket), else: socket
    socket = LiveDB.load(socket, :source, fn -> Sources.get_source(id) end, nil)

    cond do
      socket.assigns.db_unavailable ->
        {:ok, assign(socket, page_title: "Sources", note: nil, finds: [])}

      is_nil(socket.assigns.source) ->
        raise LocalfindsWeb.NotFoundError, "no source with id #{id}"

      true ->
        source = socket.assigns.source

        {:ok,
         socket
         |> assign(:page_title, source.name || host(source.url))
         |> assign(:note, Markdown.to_html(AgentNotes.read("source-keeper", source.notes_path)))
         |> LiveDB.load(:finds, fn -> Finds.list_by_source(source.id, 10) end, [])}
    end
  end

  # Dormant realtime seam (rung 4 lights this up).
  @impl true
  def handle_info({:realtime, _}, socket), do: {:noreply, socket}

  defp host(url), do: URI.parse(url).host || url

  defp status_style(status), do: Map.get(@status_style, status, "")
  defp find_status_style(status), do: Map.get(@find_status_style, status, "")

  defp short_date(nil), do: "—"
  defp short_date(%DateTime{} = dt), do: Calendar.strftime(dt, "%m/%d/%Y")

  # Decimal round-half-even, not `:erlang.float_to_binary/2` (which rounds
  # halves away from zero): 4.25 must render "4.2", and float_to_binary gives
  # "4.3" for that input.
  defp format_quality(score) do
    score
    |> Decimal.from_float()
    |> Decimal.round(1, :half_even)
    |> Decimal.to_string()
  end

  defp meta_line(source) do
    [
      source.quality_score && "quality #{format_quality(source.quality_score)}",
      "#{source.finds_count} #{if source.finds_count == 1, do: "find", else: "finds"}",
      source.last_checked_at && "checked #{short_date(source.last_checked_at)}",
      "added by #{source.added_by}",
      "created #{short_date(source.created_at)}"
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join(" · ")
  end

  @impl true
  def render(assigns) do
    ~H"""
    <.db_unavailable :if={@db_unavailable} />

    <div :if={!@db_unavailable} class="flex flex-col gap-4">
      <.link navigate={~p"/sources"} class="text-xs text-blue-700 hover:underline">
        ← Back to sources
      </.link>

      <div class="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold">{@source.name || host(@source.url)}</h2>
          <a
            href={@source.url}
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs text-blue-700 hover:underline"
          >
            {@source.url} <span aria-hidden>↗</span>
          </a>
          <span class={"rounded px-1.5 py-0.5 text-xs " <> status_style(@source.status)}>
            {@source.status}
          </span>
        </div>
        <p class="text-xs text-stone-500">{meta_line(@source)}</p>
      </div>

      <div class="rounded-lg border border-stone-200 bg-white p-4">
        <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
          Site note
        </h3>
        <div :if={@note} class="prose prose-sm prose-stone max-w-none">{@note}</div>
        <p :if={!@note} class="text-sm text-stone-500">No site note yet.</p>
      </div>

      <div :if={@finds != []} class="rounded-lg border border-stone-200 bg-white p-4">
        <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
          Recent finds from this source
        </h3>
        <ul class="flex flex-col divide-y divide-stone-100">
          <li :for={f <- @finds} class="flex flex-wrap items-center gap-2 py-2 text-sm">
            <a
              :if={f.url}
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
              class="font-medium text-stone-900 hover:underline"
            >
              {f.title}
            </a>
            <span :if={!f.url} class="font-medium text-stone-900">{f.title}</span>
            <span class={"rounded px-1.5 py-0.5 text-xs " <> find_status_style(f.status)}>
              {f.status}
            </span>
            <span class="ml-auto text-xs text-stone-500">{short_date(f.discovered_at)}</span>
          </li>
        </ul>
      </div>
    </div>
    """
  end
end
