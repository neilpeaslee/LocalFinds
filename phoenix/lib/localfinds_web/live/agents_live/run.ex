defmodule LocalfindsWeb.AgentsLive.Run do
  @moduledoc """
  One agent run — port of apps/web/src/app/agents/runs/[runId]/page.tsx.
  Steward-only, inherited from the :steward live_session.
  """
  use LocalfindsWeb, :live_view

  alias Localfinds.Runs
  alias LocalfindsWeb.LiveDB
  alias LocalfindsWeb.NotFoundError
  alias LocalfindsWeb.Realtime
  alias LocalfindsWeb.RunComponents

  @impl true
  def mount(%{"run_id" => raw_id}, _session, socket) do
    socket = if connected?(socket), do: Realtime.subscribe(socket), else: socket
    run_id = parse_id(raw_id)
    socket = LiveDB.load(socket, :run, fn -> Runs.get(run_id) end, nil)

    # A nil :run is ambiguous between "no such run" and "the database bounced,
    # so LiveDB substituted its fallback" — only the former is a 404. Same
    # disambiguation PlacesLive.Show makes for a missing place.
    cond do
      socket.assigns.db_unavailable ->
        {:ok, assign(socket, :page_title, "Run")}

      is_nil(socket.assigns.run) ->
        raise NotFoundError, "no run with id #{run_id}"

      true ->
        {:ok, socket |> assign(:now, DateTime.utc_now()) |> load()}
    end
  end

  defp parse_id(raw) do
    case Integer.parse(raw) do
      {id, ""} -> id
      _ -> raise NotFoundError, "invalid run id #{raw}"
    end
  end

  defp load(socket) do
    run = socket.assigns.run
    socket = LiveDB.load(socket, :event_list, fn -> Runs.events(run.id) end, [])
    events = socket.assigns.event_list

    socket
    # dom_id keyed on seq, so a re-inserted event updates its row rather than
    # appending a duplicate when Task 8 starts streaming into this.
    |> stream(:events, events, dom_id: &"event-#{&1.seq}", reset: true)
    |> assign(:empty?, events == [])
    |> assign(:last_seq, last_seq(events))
    |> assign(:page_title, "#{run.agent} · run ##{run.id}")
    |> assign(:warnings, Runs.count_warnings(events))
    |> assign(:stale?, Runs.stale?(run, socket.assigns.now))
    |> assign(:live?, run.status == "running" and not Runs.stale?(run, socket.assigns.now))
  end

  defp last_seq([]), do: -1
  defp last_seq(events), do: List.last(events).seq

  # Same "%-m/%-d/%Y, %-I:%M:%S %p" shape as AgentsLive.Index's started_at/1 —
  # matches `new Date(run.startedAt).toLocaleString()` byte-for-byte (Task 5's
  # finding). Duplicated rather than shared because Index's helper is private;
  # see its moduledoc-adjacent comment for the full derivation.
  defp started_at(%DateTime{} = dt), do: Calendar.strftime(dt, "%-m/%-d/%Y, %-I:%M:%S %p")

  # Dormant realtime seam (rung 4 lights this up; Task 8 attaches the tail).
  @impl true
  def handle_info({:realtime, _}, socket), do: {:noreply, socket}

  @impl true
  def render(assigns) do
    ~H"""
    <.db_unavailable :if={@db_unavailable} />
    <div :if={!@db_unavailable} class="flex flex-col gap-4">
      <.link navigate={~p"/agents"} class="text-xs text-stone-500 hover:underline">
        ← back to agents
      </.link>

      <div class="rounded-lg border border-stone-200 bg-white p-4">
        <h1 class="font-semibold">{@run.agent} · run #{@run.id}</h1>
        <dl class="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-stone-600 sm:grid-cols-3">
          <div>
            <dt class="text-stone-400">status</dt>
            <dd
              class={RunComponents.status_class(@run.status)}
              title={
                @run.status == "capped" &&
                  "stopped on its budget guardrail — results were saved"
              }
            >
              {if @stale?, do: "running — likely crashed", else: @run.status}
              <span :if={@run.error} class="text-stone-400">({@run.error})</span>
            </dd>
          </div>
          <div>
            <dt class="text-stone-400">started</dt>
            <dd>{started_at(@run.started_at)}</dd>
          </div>
          <div>
            <dt class="text-stone-400">duration</dt>
            <dd>{RunComponents.duration(@run)}</dd>
          </div>
          <div>
            <dt class="text-stone-400">turns</dt>
            <dd>{@run.num_turns || "—"}</dd>
          </div>
          <div>
            <dt class="text-stone-400">added / updated</dt>
            <dd>+{@run.items_added} / ~{@run.items_updated}</dd>
          </div>
          <div>
            <dt class="text-stone-400">cost</dt>
            <dd>
              {if @run.cost_usd,
                do: "$#{:erlang.float_to_binary(@run.cost_usd, decimals: 3)}",
                else: "—"}
            </dd>
          </div>
          <div>
            <dt class="text-stone-400">warnings</dt>
            <dd class={@warnings > 0 && "text-amber-600"}>
              {if @warnings > 0, do: "⚠ #{@warnings}", else: "0"}
            </dd>
          </div>
        </dl>
      </div>

      <RunComponents.transcript events={@streams.events} empty?={@empty?} live?={@live?} />
    </div>
    """
  end
end
