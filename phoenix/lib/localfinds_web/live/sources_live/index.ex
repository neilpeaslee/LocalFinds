defmodule LocalfindsWeb.SourcesLive.Index do
  use LocalfindsWeb, :live_view

  alias Localfinds.Sources
  alias LocalfindsWeb.Realtime
  alias LocalfindsWeb.SourceFilters, as: Filters

  @status_style %{
    "active" => "bg-green-100 text-green-800",
    "paused" => "bg-stone-200 text-stone-600",
    "dead" => "bg-red-100 text-red-800"
  }

  @impl true
  def mount(_params, _session, socket) do
    socket = if connected?(socket), do: Realtime.subscribe(socket), else: socket
    {:ok, assign(socket, :all, Sources.list_sources())}
  end

  @impl true
  def handle_params(params, _uri, socket) do
    q = params |> Map.get("q") |> normalize()
    status = Filters.parse_status(Map.get(params, "status"))
    sort = Filters.parse_sort(Map.get(params, "sort"))
    dir = Filters.parse_dir(Map.get(params, "dir"))

    all = socket.assigns.all
    rows = all |> Filters.filter(%{q: q, status: status}) |> Filters.sort(sort, dir)

    {:noreply,
     assign(socket,
       page_title: "Sources",
       q: q,
       status: status,
       sort: sort,
       dir: dir,
       # `state` bundles the query for the path helpers — render/1 has no @socket.
       state: %{q: q, status: status, sort: sort, dir: dir},
       rows: rows,
       summary: Filters.summarize(all)
     )}
  end

  # Search form submit → fold the query into the URL so state stays shareable.
  @impl true
  def handle_event("search", %{"q" => q}, socket) do
    {:noreply, push_patch(socket, to: sources_path(socket.assigns.state, %{q: normalize(q)}))}
  end

  # Dormant realtime seam (rung 4 lights this up).
  @impl true
  def handle_info({:realtime, _}, socket), do: {:noreply, socket}

  defp normalize(nil), do: nil

  defp normalize(q) do
    case String.trim(q) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  # Build a /sources path merging the current state with a patch, dropping
  # defaults (name/asc, blank q/status) so URLs stay clean — mirrors hrefWith.
  # Named `sources_path/2` (not `path/2`) to avoid colliding with the
  # `Phoenix.VerifiedRoutes.path/2` macro imported by `use LocalfindsWeb,
  # :live_view` — same arity, so a local `path/2` here would shadow it.
  defp sources_path(state, patch) do
    current = %{
      "q" => state.q,
      "status" => state.status,
      "sort" => if(state.sort == :name, do: nil, else: Atom.to_string(state.sort)),
      "dir" => if(state.dir == :asc, do: nil, else: Atom.to_string(state.dir))
    }

    query =
      current
      |> Map.merge(Map.new(patch, fn {k, v} -> {to_string(k), v} end))
      |> Enum.reject(fn {_k, v} -> v in [nil, ""] end)
      |> Enum.sort()

    if query == [], do: ~p"/sources", else: ~p"/sources?#{query}"
  end

  defp header_patch(state, key) do
    next_dir = if state.sort == key and state.dir == :asc, do: :desc, else: :asc

    sources_path(state, %{
      sort: if(key == :name, do: nil, else: Atom.to_string(key)),
      dir: if(next_dir == :asc, do: nil, else: Atom.to_string(next_dir))
    })
  end

  defp status_style(status), do: Map.get(@status_style, status, "")

  defp short_date(nil), do: "—"
  # Faithful-enough date (parity is a style guide); zero-padded m/d/Y is safe in
  # Calendar.strftime, which lacks the GNU %-m no-pad flag.
  defp short_date(%DateTime{} = dt), do: Calendar.strftime(dt, "%m/%d/%Y")

  @impl true
  def render(assigns) do
    ~H"""
    <div :if={@summary.total == 0} class="py-12 text-center text-sm text-stone-500">
      No sources registered yet. The source-keeper agent populates this on its
      first run (seed it via data/config/region.md).
    </div>

    <div :if={@summary.total > 0} class="flex flex-col gap-4">
      <div class="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3">
        <p class="text-xs text-stone-500">{summary_line(@summary)}</p>

        <form phx-submit="search" class="flex gap-2">
          <input
            type="search"
            name="q"
            value={@q}
            placeholder="Search by name or URL…"
            class="flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <button type="submit" class="rounded bg-stone-800 px-3 py-1 text-sm text-white">
            Search
          </button>
        </form>

        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-xs font-medium text-stone-500">Status</span>
          <.link patch={sources_path(@state, %{status: nil})} class={pill(is_nil(@status))}>all</.link>
          <.link
            :for={st <- Filters.statuses()}
            patch={sources_path(@state, %{status: st})}
            class={pill(@status == st)}
          >
            {st}
          </.link>
        </div>
      </div>

      <p class="text-xs text-stone-500">
        {result_line(@rows, @summary, @q, @status)}
      </p>

      <p :if={@rows == []} class="py-8 text-center text-sm text-stone-500">
        No sources match these filters.
      </p>

      <div :if={@rows != []} class="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-stone-200 text-xs text-stone-500">
              <th scope="col" class="px-3 py-2 text-left font-medium">
                <.link patch={header_patch(@state, :name)} class="inline-flex items-center gap-1 hover:text-stone-900">
                  Name <span :if={@sort == :name} aria-hidden>{arrow(@dir)}</span>
                </.link>
              </th>
              <th scope="col" class="px-3 py-2 text-left font-medium">Status</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">
                <.link patch={header_patch(@state, :finds)} class="inline-flex items-center gap-1 hover:text-stone-900">
                  Finds <span :if={@sort == :finds} aria-hidden>{arrow(@dir)}</span>
                </.link>
              </th>
              <th scope="col" class="px-3 py-2 text-right font-medium">
                <.link patch={header_patch(@state, :quality)} class="inline-flex items-center gap-1 hover:text-stone-900">
                  Quality <span :if={@sort == :quality} aria-hidden>{arrow(@dir)}</span>
                </.link>
              </th>
              <th scope="col" class="px-3 py-2 text-right font-medium">
                <.link patch={header_patch(@state, :checked)} class="inline-flex items-center gap-1 hover:text-stone-900">
                  Last checked <span :if={@sort == :checked} aria-hidden>{arrow(@dir)}</span>
                </.link>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr :for={s <- @rows} class="border-b border-stone-100 last:border-0">
              <td class="px-3 py-2">
                <a href={"/sources/#{s.id}"} class="font-medium text-stone-900 hover:underline">
                  {s.name || URI.parse(s.url).host}
                </a>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="ml-1.5 text-xs text-blue-700 hover:underline"
                  title={s.url}
                >
                  ↗
                </a>
              </td>
              <td class="px-3 py-2">
                <span class={"rounded px-1.5 py-0.5 text-xs " <> status_style(s.status)}>
                  {s.status}
                </span>
              </td>
              <td class="px-3 py-2 text-right tabular-nums">{s.finds_count}</td>
              <td class="px-3 py-2 text-right tabular-nums">
                {if s.quality_score, do: :erlang.float_to_binary(s.quality_score, decimals: 1), else: "—"}
              </td>
              <td class="px-3 py-2 text-right text-stone-500">{short_date(s.last_checked_at)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    """
  end

  defp pill(active?) do
    base = "rounded px-2 py-0.5 text-xs "

    base <>
      if active?,
        do: "bg-stone-800 text-white",
        else: "bg-stone-100 text-stone-600 hover:bg-stone-200"
  end

  defp arrow(:asc), do: "▲"
  defp arrow(:desc), do: "▼"

  defp summary_line(summary) do
    parts =
      [pluralize(summary.total, "source", "sources")] ++
        for st <- Filters.statuses(),
            summary.by_status[st] > 0,
            do: "#{summary.by_status[st]} #{st}"

    parts = parts ++ [pluralize(summary.total_finds, "find", "finds")]

    parts =
      if summary.avg_quality,
        do: parts ++ ["avg quality #{:erlang.float_to_binary(summary.avg_quality, decimals: 1)}"],
        else: parts

    Enum.join(parts, " · ")
  end

  defp result_line(rows, summary, q, status) do
    if q || status do
      "#{length(rows)} of #{summary.total} matching filters"
    else
      pluralize(summary.total, "source", "sources")
    end
  end

  defp pluralize(1, singular, _plural), do: "1 #{singular}"
  defp pluralize(n, _singular, plural), do: "#{n} #{plural}"
end
