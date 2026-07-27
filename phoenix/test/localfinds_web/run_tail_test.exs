defmodule LocalfindsWeb.RunTailTest do
  use LocalfindsWeb.ConnCase, async: false

  alias Localfinds.Repo
  alias LocalfindsWeb.RunTail

  setup do
    Repo.query!("TRUNCATE localfinds.run_events, localfinds.runs RESTART IDENTITY CASCADE")
    :ok
  end

  # Anchored to @now rather than SQL now(): drain/3's staleness check compares
  # against the @now argument the test passes in, not against wall-clock time,
  # so a default of literal "now()" made the "stale" and "live" tests flaky —
  # they'd pass or fail depending on how far the real clock had drifted from
  # the hardcoded @now at the moment the suite happened to run.
  defp run!(id, status, started \\ "'2026-07-26 12:00:00+00'") do
    Repo.query!("""
    INSERT INTO localfinds.runs (id, agent, started_at, status)
    OVERRIDING SYSTEM VALUE VALUES (#{id}, 'scout', #{started}, '#{status}')
    """)
  end

  defp event!(run_id, seq, kind, payload) do
    Repo.query!(
      "INSERT INTO localfinds.run_events (run_id, seq, kind, payload) VALUES ($1, $2, $3, $4)",
      [run_id, seq, kind, payload]
    )
  end

  @now ~U[2026-07-26 12:00:00.000000Z]

  test "drains new events and advances last_seq" do
    run!(1, "running")
    event!(1, 0, "run_start", %{"model" => "opus", "maxTurns" => 4})
    event!(1, 1, "assistant_text", %{"text" => "looking"})

    assert {:events, [%{seq: 0}, %{seq: 1}], 1} = RunTail.drain(1, -1, @now)
    assert {:events, [], 1} = RunTail.drain(1, 1, @now)
  end

  test "stops as soon as run_end arrives, and does not emit past it" do
    run!(1, "running")
    event!(1, 0, "assistant_text", %{"text" => "working"})
    event!(1, 1, "run_end", %{"status" => "success"})
    event!(1, 2, "assistant_text", %{"text" => "should not be emitted"})

    assert {:done, events, 1} = RunTail.drain(1, -1, @now)
    assert Enum.map(events, & &1.seq) == [0, 1]
  end

  test "stops when an empty batch coincides with a finished run" do
    run!(1, "success")
    assert {:done, [], -1} = RunTail.drain(1, -1, @now)
  end

  test "stops when an empty batch coincides with a stale run" do
    run!(1, "running", "'2026-07-26 11:15:00+00'")
    assert {:done, [], -1} = RunTail.drain(1, -1, @now)
  end

  test "keeps going when an empty batch coincides with a live run" do
    run!(1, "running")
    assert {:events, [], -1} = RunTail.drain(1, -1, @now)
  end

  test "a non-empty batch never triggers the run re-read" do
    # The run has already finished, but this event hasn't been emitted yet —
    # a plausible race between the poll and the status flip. Any Runs.get/1
    # call made from the non-empty branch would see status != "running" and
    # (wrongly) stop. A non-empty batch must return :events regardless — see
    # Step 5's falsification, which proves this test actually catches that.
    #
    # (The brief's original version tried to prove this by deleting the run
    # row instead. That's not reachable in practice: run_events.run_id has a
    # `REFERENCES localfinds.runs(id)` FK with no cascade — deleting a run
    # while its events survive raises a foreign-key violation, not a clean
    # "missing run" state. A finished-but-unread-event race is the real
    # equivalent this module has to handle.)
    run!(1, "success")
    event!(1, 0, "assistant_text", %{"text" => "still going"})

    assert {:events, [%{seq: 0}], 0} = RunTail.drain(1, -1, @now)
  end

  test "watch/1 schedules a tick that arrives as {:run_tail, run_id}" do
    RunTail.watch(7)
    assert_receive {:run_tail, 7}, RunTail.interval_ms() * 3
  end

  describe "on_tick/3" do
    # Not quite a bare socket: on_tick's append/3 calls stream_insert/3, and
    # Phoenix.LiveView.stream_insert/4 raises a KeyError on a socket that never
    # configured the :events stream (both real pages call `stream(:events, …)`
    # in their own `load/1` before a tick could ever fire — see run.ex:50).
    # This mirrors that minimal setup without a full LiveView mount.
    defp socket(last_seq) do
      # stream/4 attaches an :after_render hook to prune the stream, which
      # needs socket.private.lifecycle to exist — normally seeded by the real
      # mount path. Seed it by hand rather than paying for a full LiveView
      # process just to unit-test a plain function.
      %Phoenix.LiveView.Socket{
        private: %{live_temp: %{}, lifecycle: %Phoenix.LiveView.Lifecycle{}}
      }
      |> Phoenix.LiveView.stream(:events, [], dom_id: &"event-#{&1.seq}")
      |> Phoenix.Component.assign(:last_seq, last_seq)
      |> Phoenix.Component.assign(:empty?, true)
      |> Phoenix.Component.assign(:db_unavailable, false)
    end

    test "appends events, advances last_seq, and reschedules while the run is live" do
      # on_tick/3 computes "now" itself via DateTime.utc_now/0 (real wall-clock
      # time), unlike drain/3's tests above which pass a fixed @now — so this
      # run's started_at must track the real clock too, not @now's literal.
      run!(1, "running", "now()")
      event!(1, 0, "assistant_text", %{"text" => "working"})

      out = RunTail.on_tick(socket(-1), 1, fn s -> Phoenix.Component.assign(s, :done, true) end)

      assert out.assigns.last_seq == 0
      refute out.assigns.empty?
      refute out.assigns[:done]
      assert_receive {:run_tail, 1}, RunTail.interval_ms() * 3
    end

    test "runs done_fun and stops rescheduling when the run ends" do
      run!(1, "running", "now()")
      event!(1, 0, "run_end", %{"status" => "success"})

      out = RunTail.on_tick(socket(-1), 1, fn s -> Phoenix.Component.assign(s, :done, true) end)

      assert out.assigns.done
      refute_receive {:run_tail, 1}, RunTail.interval_ms() * 2
    end

    test "a missing run is not mistaken for a database bounce" do
      # This does NOT exercise DB.guard's degraded branch — that requires a
      # real DBConnection.ConnectionError or Postgrex shutdown code (see
      # Localfinds.DBTest), which isn't practical to trigger through on_tick/3
      # without a mocking dependency this project doesn't have. What this
      # pins down instead: a run_id with no matching row is a normal, healthy
      # read that comes back empty — Runs.get/1 returns nil, drain/3's
      # continue_or_stop/4 treats `run == nil` as "the run ended" and returns
      # :done, and on_tick/3 must not confuse that with :database_unavailable.
      out = RunTail.on_tick(socket(-1), -999_999, fn s -> s end)

      refute out.assigns.db_unavailable
    end
  end
end
