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
  the active-run banner is not ported here: it depends on the SSE event stream
  Task 8 wires up, and the run-detail page (linked via "open run →") is where
  that transcript lives once it exists. Until then the banner is a pointer,
  not a duplicate render surface.
  """
  use LocalfindsWeb, :live_view

  alias Localfinds.AgentProfiles
  alias Localfinds.Markdown
  alias Localfinds.Runs
  alias LocalfindsWeb.LiveDB
  alias LocalfindsWeb.Realtime
  alias LocalfindsWeb.RunComponents

  @runs_per_section 10
  @history_limit 200

  @impl true
  def mount(_params, _session, socket) do
    socket = if connected?(socket), do: Realtime.subscribe(socket), else: socket

    {:ok,
     socket
     |> assign(:page_title, "Agents")
     |> load()}
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

    socket
    |> assign(:in_progress?, Runs.in_progress?(runs, now))
    |> assign(
      :active_run,
      Enum.find(runs, &(&1.status == "running" and not Runs.stale?(&1, now)))
    )
    |> assign(:sections, sections(runs))
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

  @impl true
  def render(assigns) do
    ~H"""
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
      </section>

      <div class="flex items-center justify-between gap-4">
        <p class="text-sm text-stone-600">
          Agent spend, last 30 days:
          <span class="font-semibold">${:erlang.float_to_binary(@cost30, decimals: 2)}</span>
        </p>
        <div class="flex items-center gap-3">
          <span :if={@in_progress?} class="text-xs text-amber-700">run in progress…</span>
          <.run_button target="all" label="Run all" disabled={@in_progress?} />
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

  defp run_button(assigns) do
    ~H"""
    <button
      type="button"
      phx-click="trigger"
      phx-value-target={@target}
      disabled={@disabled}
      class="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {@label}
    </button>
    """
  end
end
