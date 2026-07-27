defmodule LocalfindsWeb.AgentsLive.Index do
  @moduledoc """
  The agents console — port of apps/web/src/app/agents/page.tsx. Steward-only
  via UserAuth.on_mount(:require_steward); it serves interest profiles, which
  are personal-taste PII.

  Sections are ROSTER plus any agent found in run history. The reference derives
  them from ROSTER alone, which hides concierge: its runs count toward the spend
  and block every trigger while appearing in no table. Non-roster sections are
  read-only — concierge needs a --query and cannot be started from here.

  The reference's inline `<RunTranscript runId={activeRun.id} live />` inside
  the active-run banner is ported here (Task 8), fed by `RunTail` rather than
  the reference's SSE stream. The run-detail page (linked via "open run →")
  renders the same events through the same `RunComponents.transcript/1`.
  """
  use LocalfindsWeb, :live_view

  require Logger

  alias Localfinds.AgentProfiles
  alias Localfinds.Agents.Spawner
  alias Localfinds.Markdown
  alias Localfinds.Runs
  alias LocalfindsWeb.LiveDB
  alias LocalfindsWeb.Realtime
  alias LocalfindsWeb.RunComponents
  alias LocalfindsWeb.RunTail
  alias LocalfindsWeb.UserAuth

  @runs_per_section 10
  @history_limit 200

  # How long a triggered spawn is given to produce its `running` row before
  # :starting gives up and releases the button — the reference's own
  # START_TIMEOUT_MS/POLL_MS (apps/web/src/app/agents/actions.ts), measured
  # there from `npx tsx` cold start + SDK init (~10s observed). The reference
  # blocked the request for up to this long; here it bounds a self-message
  # poll instead, so the click itself still returns immediately.
  @await_budget_ms 20_000
  @await_poll_ms 250

  # Cadence for the idle-state poller below — deliberately slower than the
  # 700ms armed transcript tail (RunTail.interval_ms/0), since its only job is
  # noticing that *something* started, not streaming it. Read at call time
  # rather than a bare module attribute so a test can shrink it far below 5s
  # and prove a real Process.send_after fires — without that seam, the only
  # way to test that mount/1 (or the tail ending, or :await_run finishing)
  # actually *schedules* a heartbeat, rather than merely reacting correctly
  # to a hand-sent one, is to wait out the real production interval in CI.
  @heartbeat_ms_default 5_000
  defp heartbeat_ms, do: Application.get_env(:localfinds, :heartbeat_ms, @heartbeat_ms_default)

  @impl true
  def mount(_params, _session, socket) do
    socket = if connected?(socket), do: Realtime.subscribe(socket), else: socket

    {:ok,
     socket
     |> assign(:page_title, "Agents")
     # Task 10 introduces the optimistic "starting…" state; seeded here so
     # the tail's done_fun (which clears it) is valid before that lands.
     |> assign(:starting, nil)
     |> load()
     |> resume_polling()}
  end

  defp load(socket) do
    now = DateTime.utc_now()

    socket
    |> assign(:now, now)
    |> LiveDB.load(:runs, fn -> Runs.list(@history_limit) end, [])
    |> LiveDB.load(:cost30, fn -> Runs.cost_last_n_days(30) end, 0.0)
    |> derive(now)
  end

  defp derive(socket, now) do
    runs = socket.assigns.runs
    active = Enum.find(runs, &(&1.status == "running" and not Runs.stale?(&1, now)))

    socket
    |> assign(:in_progress?, Runs.in_progress?(runs, now))
    |> assign(:active_run, active)
    |> assign(:sections, sections(runs))
    |> seed_banner(active)
  end

  # Seeds the banner's own transcript stream. Reset each time derive/2 runs
  # (mount, and the tail's done_fun) so a run ending or a different run
  # becoming active never leaves stale rows from a previous run in the DOM.
  defp seed_banner(socket, nil) do
    socket
    |> stream(:events, [], dom_id: &"event-#{&1.seq}", reset: true)
    |> assign(:empty?, true)
    |> assign(:last_seq, -1)
  end

  defp seed_banner(socket, run) do
    socket = LiveDB.load(socket, :event_list, fn -> Runs.events(run.id) end, [])
    events = socket.assigns.event_list

    socket
    |> stream(:events, events, dom_id: &"event-#{&1.seq}", reset: true)
    |> assign(:empty?, events == [])
    |> assign(:last_seq, if(events == [], do: -1, else: List.last(events).seq))
  end

  defp sections(runs) do
    by_agent = Enum.group_by(runs, & &1.agent)
    extras = by_agent |> Map.keys() |> Kernel.--(Runs.roster()) |> Enum.sort()

    Enum.map(Runs.roster(), &section(&1, by_agent, true)) ++
      Enum.map(extras, &section(&1, by_agent, false))
  end

  defp section(agent, by_agent, triggerable?) do
    %{
      agent: agent,
      triggerable?: triggerable?,
      runs: by_agent |> Map.get(agent, []) |> Enum.take(@runs_per_section),
      profile: agent |> AgentProfiles.read() |> Markdown.to_html()
    }
  end

  # Rung 4 replaces the tick behind Realtime; the page's contract does not move.
  @impl true
  def handle_info({:realtime, _}, socket), do: {:noreply, socket}

  # Same RunTail.on_tick/3 as the detail page. On run end, clear :starting so
  # Task 10's optimistic "starting…" banner never outlives the run it
  # announced, then re-load so the run tables and 30-day spend settle
  # together — the console's equivalent of the reference's router.refresh() —
  # and hand off to resume_polling/1 so a subsequent run (this socket's own
  # next click, or one started anywhere else) is still noticed once this run
  # is no longer the thing occupying the timer slot.
  @impl true
  def handle_info({:run_tail, run_id}, socket) do
    {:noreply,
     RunTail.on_tick(
       socket,
       run_id,
       &(&1 |> assign(:starting, nil) |> load() |> resume_polling())
     )}
  end

  # Restores the reference's "wait until the running row appears" guarantee
  # without putting the wait inside handle_event: the click already returned,
  # and this self-message polls in the LiveView process instead. Each tick
  # used to call the full load/1 — 2 queries plus sections/1 re-reading and
  # re-rendering every agent's profile.md through Earmark and HtmlSanitizeEx —
  # on every 250ms beat for up to 20s, whether or not anything had changed.
  # fresh_in_progress?/0 is the same narrow, indexed read the trigger guard
  # below uses, so most ticks now cost one cheap query; load/1 (and its
  # markdown pipeline) runs exactly once, on the tick that actually finds the
  # row. A spawn that never produces a row within @await_budget_ms (crashed
  # before its own startRun, or the box is unreachable) still releases the
  # button - stuck-disabled-forever is exactly the failure mode this is
  # guarding against - and logs it as an ops signal, never as page copy. Either
  # way, resume_polling/1 hands off to whichever poller is appropriate next:
  # RunTail.watch/1 if a row landed, or the heartbeat if it never did — a row
  # that lands moments after this gives up is no longer invisible to the UI,
  # just to this particular click's own optimistic "starting…" state.
  @impl true
  def handle_info({:await_run, target, deadline}, socket) do
    cond do
      fresh_in_progress?() ->
        {:noreply, socket |> load() |> assign(:starting, nil) |> resume_polling()}

      System.monotonic_time(:millisecond) >= deadline ->
        Logger.warning(
          "agent spawn for #{inspect(target)} never produced a running row within #{@await_budget_ms}ms"
        )

        {:noreply, socket |> assign(:starting, nil) |> resume_polling()}

      true ->
        Process.send_after(self(), {:await_run, target, deadline}, @await_poll_ms)
        {:noreply, socket}
    end
  end

  # The heartbeat: the console's only way of noticing a run that started
  # without this socket's own involvement — the roster cron, another
  # steward's click, another browser tab. mount/3, an ending tail, and
  # :await_run giving up all hand off here via resume_polling/1; this is the
  # other end of that hand-off, ticking every heartbeat_ms/0 while idle until
  # something needs a faster poller instead.
  #
  # idle?/1 guards the whole tick, not just whether to act on the result,
  # because timers here are never cancelled, only left to expire: a
  # :heartbeat message already in flight when the console starts tailing (or
  # starts awaiting a click's own spawn) still arrives, and must be a pure
  # no-op — RunTail's own reschedule, or :await_run's own poll, already owns
  # the job for as long as either is running, and each calls resume_polling/1
  # itself on the way out. This branch neither re-arms nor reschedules, so it
  # can never double-arm RunTail.watch/1 on top of an already-armed tail: two
  # ticks can only both see `{:ok, true}` and both try to arm one if both are
  # processed while genuinely idle, and LiveView's mailbox is sequential — the
  # first to run flips :active_run and stops being idle before the second is
  # ever handled. A stray timer can outlive its usefulness (harmless: one
  # extra no-op tick) but never survives past a tail actually being armed,
  # since real runs stay tailed for minutes, not the few seconds a leftover
  # heartbeat could still have left on its own clock.
  @impl true
  def handle_info(:heartbeat, socket) do
    if idle?(socket) do
      case fresh_running?(DateTime.utc_now()) do
        {:ok, true} ->
          {:noreply, socket |> load() |> resume_polling()}

        {:ok, false} ->
          schedule_heartbeat()
          {:noreply, socket}

        {:error, :database_unavailable} ->
          # Same degrade-and-stop contract as everywhere else on this page: a
          # page that has already told the visitor it's degraded should not
          # silently half-recover, and a reconnect mounts fresh — so this
          # does not reschedule itself.
          {:noreply, assign(socket, :db_unavailable, true)}
      end
    else
      {:noreply, socket}
    end
  end

  # `new Date(run.startedAt).toLocaleString()` in the reference renders in the
  # locale/timezone of whatever machine executes the SSR — practically, this
  # codebase's server-rendered dates are formatted straight off the UTC value
  # (see LocalfindsWeb.Format's moduledoc, "Both format the UTC value, matching
  # the server-rendered reference"), so this follows the same house choice
  # rather than converting to a timezone the LiveView has no way to know.
  # `toLocaleString()` with no locale argument renders the default locale's
  # short date/time — for en-US that is unpadded month/day/hour with
  # zero-padded minutes/seconds (e.g. "7/5/2026, 3:04:05 AM", not
  # "07/05/2026, 03:04:05 AM"). Elixir's Calendar.strftime supports the same
  # GNU `-` no-pad flag, so `%-m/%-d/%Y, %-I:%M:%S %p` reproduces that shape
  # exactly rather than only approximating it.
  defp started_at(%DateTime{} = dt), do: Calendar.strftime(dt, "%-m/%-d/%Y, %-I:%M:%S %p")

  # The trigger. Order matters and is security-relevant: steward re-check (the
  # mount gate makes this unreachable through the router; :current_scope is
  # fixed by assign_new at mount and never refreshes, so this is not a defence
  # against a scope changing mid-session — it IS sound defense-in-depth
  # against a hand-crafted socket frame bypassing the router entirely) ->
  # allowlist (Runs.resolve_target's fixed roster is the only thing
  # Spawner.run/1's moduledoc trusts the caller to have already checked) ->
  # in-progress guard (agents share the DB and profiles, so only one run at a
  # time) -> spawn. No blocking wait: the reference
  # (apps/web/src/app/agents/actions.ts) polls up to 20s for the `running` row
  # so its re-render shows it; handle_info({:await_run, ...}) above restores
  # that guarantee off the click's critical path instead of inside it.
  @impl true
  def handle_event("trigger", %{"target" => target}, socket) do
    with true <- UserAuth.steward?(socket.assigns[:current_scope]),
         {:ok, resolved} <- Runs.resolve_target(target),
         false <- already_starting_or_running?(socket),
         :ok <- Spawner.run(resolved) do
      deadline = System.monotonic_time(:millisecond) + @await_budget_ms
      Process.send_after(self(), {:await_run, resolved, deadline}, @await_poll_ms)
      {:noreply, assign(socket, :starting, resolved)}
    else
      {:error, reason} ->
        # Ops signal, not UI copy: the steward gets a flash, the reason (a
        # shell exit code/output, or :no_data_dir) goes to the log a real spawn
        # already writes to, never onto the page.
        Logger.error("agent spawn failed for #{inspect(target)}: #{inspect(reason)}")
        {:noreply, put_flash(socket, :error, "Could not start the run — try again in a moment.")}

      _ ->
        {:noreply, socket}
    end
  end

  # Catch-all: a malformed frame (e.g. no "target" key) must not crash the page.
  def handle_event("trigger", _params, socket), do: {:noreply, socket}

  # Refuses a second trigger while a spawn is still being confirmed, not just
  # while a `running` row already exists on the board. Two independent halves,
  # both load-bearing:
  #
  # - :starting closes the window between a successful spawn and the CLI's own
  #   `running` row landing — nothing in the database yet shows this run, so
  #   only the socket's own optimistic flag can catch it.
  # - fresh_in_progress?/0 closes every window :starting cannot see: a run
  #   that was already live before this socket's own last reload (another
  #   steward's click, the roster cron, a second browser tab), or this same
  #   socket's own spawn whose await already gave up and cleared :starting
  #   before the row finally landed. socket.assigns.runs is a cache, refreshed
  #   only by load/1 (mount, an armed tail's done_fun, or this socket's own
  #   :await_run poll) — a console that mounted with nothing running and never
  #   triggers anything itself never reloads it again, so reading that cache
  #   here would leave the buttons enabled for the life of the connection.
  #   Reading the database fresh on every check is what the reference does too
  #   (apps/web/src/app/agents/actions.ts re-reads inside the server action on
  #   every click) — this restores that guarantee lost when the cached list
  #   was reused here instead.
  #
  # A database bounce degrades to "refuse": if we cannot confirm nothing is
  # running, spawning a possibly-second CLI against the shared production
  # Postgres is the wrong default.
  defp already_starting_or_running?(socket) do
    not is_nil(socket.assigns.starting) or fresh_in_progress?()
  end

  # A database bounce degrades to "yes, in progress" — refuse a spawn rather
  # than risk a second one. fresh_running?/1 below is the shared, honest
  # (non-defaulted) version of this same read, used where the caller needs to
  # tell "nothing running" apart from "couldn't tell."
  defp fresh_in_progress? do
    case fresh_running?(DateTime.utc_now()) do
      {:ok, in_progress?} -> in_progress?
      {:error, :database_unavailable} -> true
    end
  end

  @spec fresh_running?(DateTime.t()) :: {:ok, boolean()} | {:error, :database_unavailable}
  defp fresh_running?(now) do
    case Localfinds.DB.guard(fn -> Runs.running() end) do
      {:ok, runs} -> {:ok, Runs.in_progress?(runs, now)}
      {:error, :database_unavailable} = error -> error
    end
  end

  # "Idle" = no poller already owns the job the heartbeat exists to do: not
  # mid-spawn-confirmation (:starting, whose own :await_run poll already
  # re-checks fresh_in_progress?/0 on its own schedule) and not already
  # tailing a live run (:active_run, whose RunTail.watch/1 reschedules
  # itself). Both are updated together with every poller hand-off below, so
  # this stays accurate without a separate "am I polling" flag to drift out
  # of sync with them.
  defp idle?(socket) do
    is_nil(socket.assigns.starting) and is_nil(socket.assigns.active_run)
  end

  # The single hand-off point every poller returns control through: mount,
  # an ending tail's done_fun, and both ends of :await_run. Exactly one of
  # "arm the live tail" or "schedule the next heartbeat" happens — never
  # both, never neither (short of a disconnected socket or an already-
  # degraded page, where no poller should be running at all).
  defp resume_polling(socket) do
    cond do
      not connected?(socket) ->
        socket

      socket.assigns.db_unavailable ->
        socket

      socket.assigns.active_run ->
        RunTail.watch(socket.assigns.active_run.id)
        socket

      true ->
        schedule_heartbeat()
        socket
    end
  end

  defp schedule_heartbeat, do: Process.send_after(self(), :heartbeat, heartbeat_ms())

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.flash_group flash={@flash} />

    <.db_unavailable :if={@db_unavailable} />
    <div :if={!@db_unavailable} class="flex flex-col gap-6">
      <section
        :if={@active_run}
        class="rounded-lg border border-amber-200 bg-amber-50/40 p-4"
      >
        <div class="mb-2 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-amber-800">{@active_run.agent} running…</h2>
          <.link
            navigate={~p"/agents/runs/#{@active_run.id}"}
            class="text-xs text-stone-500 hover:underline"
          >
            open run →
          </.link>
        </div>

        <RunComponents.transcript
          id="banner-transcript"
          events={@streams.events}
          empty?={@empty?}
          live?={true}
        />
      </section>

      <div class="flex items-center justify-between gap-4">
        <p class="text-sm text-stone-600">
          Agent spend, last 30 days:
          <span class="font-semibold">${:erlang.float_to_binary(@cost30, decimals: 2)}</span>
        </p>
        <div class="flex items-center gap-3">
          <span :if={@in_progress?} class="text-xs text-amber-700">run in progress…</span>
          <.run_button target="all" label="Run all" disabled={@in_progress?} starting={@starting} />
        </div>
      </div>

      <section
        :for={section <- @sections}
        class="rounded-lg border border-stone-200 bg-white p-4"
      >
        <div class="flex items-center justify-between gap-4">
          <h2 class="font-semibold">{section.agent}</h2>
          <.run_button
            :if={section.triggerable?}
            target={section.agent}
            label="Run"
            disabled={@in_progress?}
            starting={@starting}
          />
        </div>

        <details class="mt-2">
          <summary class="cursor-pointer text-sm text-stone-600">
            Interest profile (data/agents/{section.agent}/profile.md — hand-editable)
          </summary>
          <div class="prose prose-sm prose-stone mt-2 max-w-none rounded bg-stone-50 p-3">
            <%= if section.profile do %>
              {section.profile}
            <% else %>
              <p class="text-stone-500">No profile yet — created on the agent's first run.</p>
            <% end %>
          </div>
        </details>

        <p :if={section.runs == []} class="mt-3 text-sm text-stone-500">No runs yet.</p>
        <table :if={section.runs != []} class="mt-3 w-full text-left">
          <thead>
            <tr class="text-xs text-stone-500">
              <th class="pr-3 font-normal">started</th>
              <th class="pr-3 font-normal">status</th>
              <th class="pr-3 text-right font-normal">time</th>
              <th class="pr-3 text-right font-normal">turns</th>
              <th class="pr-3 text-right font-normal">added/upd</th>
              <th class="text-right font-normal">cost</th>
            </tr>
          </thead>
          <tbody>
            <tr :for={run <- section.runs} class="border-t border-stone-100 text-xs">
              <td class="py-1 pr-3 whitespace-nowrap">
                <.link navigate={~p"/agents/runs/#{run.id}"} class="text-stone-700 hover:underline">
                  {started_at(run.started_at)}
                </.link>
              </td>
              <td class="pr-3">
                <span :if={Runs.stale?(run, @now)} class="text-red-700">
                  running — likely crashed
                </span>
                <span
                  :if={!Runs.stale?(run, @now)}
                  class={RunComponents.status_class(run.status)}
                  title={
                    run.status == "capped" &&
                      "stopped on its budget guardrail — results were saved"
                  }
                >
                  {run.status}
                </span>
                <span :if={run.error} class="text-stone-400"> ({run.error})</span>
                <span
                  :if={run.warnings > 0}
                  class="ml-1 text-amber-600"
                  title={"#{run.warnings} non-fatal tool failure(s) during this run"}
                >
                  ⚠ {run.warnings}
                </span>
              </td>
              <td class="pr-3 text-right">{RunComponents.duration(run)}</td>
              <td class="pr-3 text-right">{run.num_turns || "—"}</td>
              <td class="pr-3 text-right">+{run.items_added} / ~{run.items_updated}</td>
              <td class="text-right">
                {if run.cost_usd, do: "$#{:erlang.float_to_binary(run.cost_usd, decimals: 3)}", else: "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
    """
  end

  attr :target, :string, required: true
  attr :label, :string, required: true
  attr :disabled, :boolean, required: true
  attr :starting, :string, default: nil

  defp run_button(assigns) do
    ~H"""
    <button
      type="button"
      phx-click="trigger"
      phx-value-target={@target}
      disabled={@disabled or not is_nil(@starting)}
      class="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {if @starting == @target, do: "starting…", else: @label}
    </button>
    """
  end
end
