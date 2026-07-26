defmodule Localfinds.Runs do
  @moduledoc """
  Read queries and pure predicates over localfinds.runs / run_events.

  Port of packages/db/src/runs.ts, run-events.ts, and the run queries in
  queries.ts. Read-only by design: the /agents Run buttons spawn a CLI that
  writes as a different role, so nothing here mutates.
  """
  import Ecto.Query

  alias Localfinds.Repo
  alias Localfinds.Runs.Run
  alias Localfinds.Runs.RunEvent

  # The roster, in the order the "all" sequence runs them (prospector before
  # curator, so curator prunes leads the same cycle). Mirrors ROSTER in runs.ts.
  @roster ["scout", "source-keeper", "prospector", "curator"]
  @run_targets @roster ++ ["all"]

  # A `running` row older than this is treated as crashed: it stops blocking new
  # triggers and the UI flags it. Runs are capped and finish in minutes.
  @stale_ms 20 * 60 * 1000

  @spec roster() :: [String.t()]
  def roster, do: @roster

  @spec resolve_target(String.t()) :: {:ok, String.t()} | :error
  def resolve_target(input) when is_binary(input) do
    if input in @run_targets, do: {:ok, input}, else: :error
  end

  def resolve_target(_), do: :error

  @spec stale?(Run.t(), DateTime.t()) :: boolean()
  def stale?(%Run{status: "running", started_at: %DateTime{} = started}, %DateTime{} = now) do
    DateTime.diff(now, started, :millisecond) >= @stale_ms
  end

  def stale?(_run, _now), do: false

  @spec in_progress?([Run.t()], DateTime.t()) :: boolean()
  def in_progress?(runs, %DateTime{} = now) do
    Enum.any?(runs, &(&1.status == "running" and not stale?(&1, now)))
  end

  @spec list(pos_integer()) :: [Run.t()]
  def list(limit \\ 200) do
    Repo.all(from r in Run, order_by: [desc: r.started_at], limit: ^limit)
  end

  @spec get(integer()) :: Run.t() | nil
  def get(id) when is_integer(id), do: Repo.get(Run, id)

  @spec cost_last_n_days(pos_integer()) :: float()
  def cost_last_n_days(days \\ 30) do
    since = DateTime.add(DateTime.utc_now(), -days * 86_400, :second)

    from(r in Run, where: r.started_at >= ^since, select: sum(r.cost_usd))
    |> Repo.one()
    |> case do
      nil -> 0.0
      total -> total
    end
  end

  @spec events(integer()) :: [RunEvent.t()]
  def events(run_id) when is_integer(run_id) do
    Repo.all(from e in RunEvent, where: e.run_id == ^run_id, order_by: e.seq)
  end

  @spec events_since(integer(), integer()) :: [RunEvent.t()]
  def events_since(run_id, after_seq) when is_integer(run_id) and is_integer(after_seq) do
    Repo.all(
      from e in RunEvent,
        where: e.run_id == ^run_id and e.seq > ^after_seq,
        order_by: e.seq
    )
  end

  # Tool results the SDK flagged as errors — non-fatal failures inside a run
  # that still finishes "success". `isError` is a camelCase jsonb key.
  @spec count_warnings([RunEvent.t()]) :: non_neg_integer()
  def count_warnings(events) do
    Enum.count(events, &(&1.kind == "tool_result" and &1.payload["isError"] == true))
  end
end
