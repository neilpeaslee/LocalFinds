defmodule LocalfindsWeb.RunTail do
  @moduledoc """
  The live transcript's source. Port of the poll inside
  apps/web/src/app/api/runs/[runId]/stream/route.ts, moved inside the LiveView
  now that the SSE bridge is gone.

  **This module is the rung-4 seam.** Replacing the poll with a Postgres
  LISTEN/NOTIFY subscription broadcast over PubSub should change this file and
  neither LiveView: the pages' contract is a `{:run_tail, run_id}` message and
  a `drain/3` that answers with events plus whether to stop.
  """

  alias Localfinds.Runs

  @interval_ms 700

  @spec interval_ms() :: pos_integer()
  def interval_ms, do: @interval_ms

  @doc "Schedule the next tick for this run. The caller receives {:run_tail, run_id}."
  @spec watch(integer()) :: reference()
  def watch(run_id) when is_integer(run_id) do
    Process.send_after(self(), {:run_tail, run_id}, @interval_ms)
  end

  @doc """
  Read the events after `last_seq`. Returns `{:done, …}` when the tail should
  stop — a run_end event arrived, or the batch was empty and the run has ended.

  The run re-read happens **only** when the batch is empty. That is deliberate
  in the reference: an actively streaming run never pays the extra round-trip.
  """
  @spec drain(integer(), integer(), DateTime.t()) ::
          {:events | :done, [Localfinds.Runs.RunEvent.t()], integer()}
  def drain(run_id, last_seq, %DateTime{} = now) do
    events = Runs.events_since(run_id, last_seq)

    case Enum.split_while(events, &(&1.kind != "run_end")) do
      {_all, []} -> continue_or_stop(run_id, events, last_seq, now)
      {before, [ending | _]} -> {:done, before ++ [ending], ending.seq}
    end
  end

  defp continue_or_stop(_run_id, [_ | _] = events, _last_seq, _now) do
    {:events, events, List.last(events).seq}
  end

  defp continue_or_stop(run_id, [], last_seq, now) do
    run = Runs.get(run_id)

    if run == nil or run.status != "running" or Runs.stale?(run, now) do
      {:done, [], last_seq}
    else
      {:events, [], last_seq}
    end
  end

  @doc """
  One tick, end to end: guard the read, append what arrived, reschedule or
  finish. Both LiveViews call this so neither carries a copy of the branch
  logic — and so rung 4 has one place to change.

  `done_fun` is applied to the socket when the run ends; the pages use it to
  re-read their own rows so stats settle in place.

  The read is guarded because the shared Postgres bounces roughly weekly under
  apt upgrades. On a bounce the page degrades and the tail STOPS: a page that
  has told the visitor it is degraded should not silently half-recover, and a
  reconnect mounts a fresh process.
  """
  @spec on_tick(Phoenix.LiveView.Socket.t(), integer(), (Phoenix.LiveView.Socket.t() ->
                                                           Phoenix.LiveView.Socket.t())) ::
          Phoenix.LiveView.Socket.t()
  def on_tick(socket, run_id, done_fun) when is_function(done_fun, 1) do
    case Localfinds.DB.guard(fn -> drain(run_id, socket.assigns.last_seq, DateTime.utc_now()) end) do
      {:ok, {:events, events, last_seq}} ->
        watch(run_id)
        append(socket, events, last_seq)

      {:ok, {:done, events, last_seq}} ->
        socket |> append(events, last_seq) |> done_fun.()

      {:error, :database_unavailable} ->
        Phoenix.Component.assign(socket, :db_unavailable, true)
    end
  end

  defp append(socket, [], last_seq), do: Phoenix.Component.assign(socket, :last_seq, last_seq)

  defp append(socket, events, last_seq) do
    events
    |> Enum.reduce(socket, &Phoenix.LiveView.stream_insert(&2, :events, &1))
    |> Phoenix.Component.assign(:empty?, false)
    |> Phoenix.Component.assign(:last_seq, last_seq)
  end
end
