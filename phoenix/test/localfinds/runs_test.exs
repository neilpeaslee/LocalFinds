defmodule Localfinds.RunsTest do
  use Localfinds.DataCase, async: false

  alias Localfinds.Repo
  alias Localfinds.Runs

  setup do
    Repo.query!("TRUNCATE localfinds.run_events, localfinds.runs RESTART IDENTITY CASCADE")
    :ok
  end

  defp insert_run!(id, attrs) do
    agent = Map.get(attrs, :agent, "scout")
    status = Map.get(attrs, :status, "success")
    started = Map.get(attrs, :started_at, "now()")
    cost = Map.get(attrs, :cost_usd, "NULL")

    Repo.query!("""
    INSERT INTO localfinds.runs (id, agent, started_at, status, cost_usd)
    OVERRIDING SYSTEM VALUE
    VALUES (#{id}, '#{agent}', #{started}, '#{status}', #{cost})
    """)
  end

  # Events are written by the Node CLI, so payload keys are camelCase. Building
  # them through raw SQL here keeps the fixtures honest about that.
  defp insert_event!(run_id, seq, kind, payload) do
    Repo.query!(
      "INSERT INTO localfinds.run_events (run_id, seq, kind, payload) VALUES ($1, $2, $3, $4)",
      [run_id, seq, kind, payload]
    )
  end

  describe "resolve_target/1" do
    test "accepts every roster agent and \"all\"" do
      for target <- Runs.roster() ++ ["all"] do
        assert {:ok, ^target} = Runs.resolve_target(target)
      end
    end

    test "rejects anything else" do
      assert :error = Runs.resolve_target("concierge")
      assert :error = Runs.resolve_target("../../etc/passwd")
      assert :error = Runs.resolve_target("")
    end
  end

  describe "stale?/2 and in_progress?/2" do
    test "a running row younger than 20 minutes is in progress and not stale" do
      now = ~U[2026-07-26 12:00:00.000000Z]
      run = %Runs.Run{status: "running", started_at: ~U[2026-07-26 11:50:00.000000Z]}

      refute Runs.stale?(run, now)
      assert Runs.in_progress?([run], now)
    end

    test "a running row at exactly 20 minutes is stale and no longer blocks" do
      now = ~U[2026-07-26 12:00:00.000000Z]
      run = %Runs.Run{status: "running", started_at: ~U[2026-07-26 11:40:00.000000Z]}

      assert Runs.stale?(run, now)
      refute Runs.in_progress?([run], now)
    end

    test "a finished row is never stale and never in progress" do
      now = ~U[2026-07-26 12:00:00.000000Z]
      run = %Runs.Run{status: "success", started_at: ~U[2026-07-25 01:00:00.000000Z]}

      refute Runs.stale?(run, now)
      refute Runs.in_progress?([run], now)
    end
  end

  describe "list/1 and get/1" do
    test "lists newest first and honours the limit" do
      insert_run!(1, %{started_at: "now() - interval '2 hours'"})
      insert_run!(2, %{started_at: "now() - interval '1 hour'"})
      insert_run!(3, %{started_at: "now()"})

      assert [%{id: 3}, %{id: 2}] = Runs.list(2)
    end

    test "get/1 returns the row, or nil for an unknown id" do
      insert_run!(7, %{agent: "curator"})

      assert %{id: 7, agent: "curator"} = Runs.get(7)
      assert Runs.get(999) == nil
    end
  end

  describe "cost_last_n_days/1" do
    test "sums only runs inside the window, and returns 0.0 when there are none" do
      insert_run!(1, %{started_at: "now() - interval '2 days'", cost_usd: "1.50"})
      insert_run!(2, %{started_at: "now() - interval '40 days'", cost_usd: "9.99"})

      assert_in_delta Runs.cost_last_n_days(30), 1.50, 0.001
      assert Runs.cost_last_n_days(1) == 0.0
    end
  end

  describe "events/1, events_since/2 and count_warnings/1" do
    setup do
      insert_run!(1, %{status: "running"})

      insert_event!(1, 0, "run_start", %{
        "agent" => "scout",
        "runId" => 1,
        "model" => "opus",
        "maxTurns" => 30
      })

      insert_event!(1, 1, "tool_result", %{
        "toolUseId" => "a",
        "content" => "ok",
        "isError" => false
      })

      insert_event!(1, 2, "tool_result", %{
        "toolUseId" => "b",
        "content" => "boom",
        "isError" => true
      })

      :ok
    end

    test "events/1 returns every row in seq order with camelCase payload keys" do
      assert [first, _, third] = Runs.events(1)
      assert first.seq == 0
      assert first.kind == "run_start"
      assert first.payload["maxTurns"] == 30
      assert third.payload["isError"] == true
    end

    test "events_since/2 returns only rows after the given seq; -1 returns everything" do
      assert [%{seq: 2}] = Runs.events_since(1, 1)
      assert length(Runs.events_since(1, -1)) == 3
      assert Runs.events_since(1, 2) == []
    end

    test "count_warnings/1 counts only tool_result rows flagged isError" do
      assert Runs.count_warnings(Runs.events(1)) == 1
      assert Runs.count_warnings([]) == 0
    end
  end
end
