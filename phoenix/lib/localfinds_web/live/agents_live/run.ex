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
  alias LocalfindsWeb.RunTail

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
        {:ok,
         socket
         |> assign(:now, DateTime.utc_now())
         |> load()
         |> then(fn socket ->
           # run_id, not socket.assigns.run_id: mount/3 never assigns the raw id
           # to the socket (only the loaded :run struct), so the closed-over
           # local variable is the tail's run id here.
           if connected?(socket) and socket.assigns.live?, do: RunTail.watch(run_id)
           socket
         end)}
    end
  end

  defp parse_id(raw) do
    case Integer.parse(raw) do
      {id, ""} -> id
      _ -> raise NotFoundError, "invalid run id #{raw}"
    end
  end

  # Does NOT re-fetch :run — it reuses whatever :run struct is already in the
  # socket's assigns. Correct at mount, where the caller just fetched it. The
  # tail's done-path needs a fresh row (status/finished_at/etc. flip on
  # run_end) and goes through reload/1 below for that; calling this directly
  # from a stale-:run context will re-derive :stale?/:live?/:warnings from
  # the OLD row and look fresh without being fresh.
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

  # Dormant realtime seam (rung 4 lights this up).
  @impl true
  def handle_info({:realtime, _}, socket), do: {:noreply, socket}

  # RunTail.on_tick/3 owns the guard, the branching and the appending — see
  # its moduledoc. On run end, re-read the row so turns, cost, added/updated
  # and warnings settle in place, which is what the reference achieved with
  # router.refresh().
  @impl true
  def handle_info({:run_tail, run_id}, socket) do
    {:noreply, RunTail.on_tick(socket, run_id, &reload/1)}
  end

  # load/1 alone reuses socket.assigns.run as-is — correct at mount, since the
  # caller just fetched it — but the done_fun runs after the row itself
  # changed underneath the socket (status, finished_at, num_turns, cost_usd,
  # items_added/updated all flip on run_end). Re-reading :run first is what
  # actually makes the stat block settle to final values; load/1's own
  # re-read only ever covered the events.
  defp reload(socket) do
    socket
    |> LiveDB.load(:run, fn -> Runs.get(socket.assigns.run.id) end, socket.assigns.run)
    |> load()
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.flash_group flash={@flash} />

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
