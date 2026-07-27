defmodule LocalfindsWeb.AgentsLive.HeartbeatTest do
  @moduledoc """
  Final-review fix, second pass on /agents' timer logic: a console that
  mounted with nothing running had no way to notice a run that started
  without its own involvement. RunTail.watch/1 was only ever armed at mount
  (if a run was ALREADY active there) or by this socket's own :await_run poll
  (only scheduled by its own click) — a run started by the roster cron,
  another steward's click, or another browser tab was invisible on an
  already-open console for the life of the connection. Reproduced live by
  Neil: opened /agents, started a run from outside the page, and watched
  neither the banner nor the transcript ever appear (a reload fixed it).

  handle_info(:heartbeat, socket) in index.ex is the fix: a slow (5s, default
  — see heartbeat_ms/0), cheap (Runs.running/0, not the full load/1)
  idle-state poll that hands off to the real RunTail the moment a run
  actually appears, and to nothing at all whenever a tail or an :await_run
  poll already owns that job. Most tests here drive it with a direct
  `send(lv.pid, :heartbeat)` rather than sleeping — deterministic, matching
  tail_test.exs's own house style for RunTail's ticks.

  That hand-sent style has a real blind spot, caught in re-review: it proves
  the handler reacts correctly to a tick, never that a tick is ever actually
  *scheduled*. Deleting `|> resume_polling()` from any of index.ex's four
  hand-off points (mount, the tail's done_fun, and both branches of
  :await_run) shipped every hand-sent test above green — one of those
  deletions is literally the pre-fix bug Neil found live. The "real-timer
  canaries" describe block below is the thin layer that actually catches
  that: each one shrinks heartbeat_ms/0 (config-driven for exactly this
  reason — 5s is too slow to wait on in CI) and proves an update lands with
  no hand-sent message of any kind, the same way tail_test.exs's own single
  real-timer test proves RunTail's production wiring rather than just its
  handle_info/2 body.
  """
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase
  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.run_events, localfinds.runs RESTART IDENTITY CASCADE")
    # Only the real-timer canaries below click a Run button (to isolate
    # :await_run's own two branches from a fake, already-landed row) —
    # SpawnerStub messages this pid so assert_receive {:spawned, _} works.
    Application.put_env(:localfinds, :spawner_test_pid, self())
    steward = create_user!("s@example.com", "correct horse battery", "steward")

    on_exit(fn -> Application.delete_env(:localfinds, :spawner_test_pid) end)

    {:ok, conn: log_in_user(conn, steward)}
  end

  # No explicit id: localfinds.runs.id is a GENERATED ALWAYS identity column,
  # and OVERRIDING SYSTEM VALUE to set one by hand does not advance the
  # underlying sequence — a later plain insert in the same test would then
  # collide on the id it was implicitly given earlier. Letting Postgres
  # assign every id and handing the caller the real one back sidesteps that
  # entirely.
  defp run!(agent, status) do
    %{rows: [[id]]} =
      Repo.query!(
        """
        INSERT INTO localfinds.runs (agent, started_at, status)
        VALUES ($1, now(), $2)
        RETURNING id
        """,
        [agent, status]
      )

    id
  end

  defp event!(run_id, seq, kind, payload) do
    Repo.query!(
      "INSERT INTO localfinds.run_events (run_id, seq, kind, payload) VALUES ($1, $2, $3, $4)",
      [run_id, seq, kind, payload]
    )
  end

  test "Neil's scenario: a run started entirely outside the console appears without a reload",
       %{conn: conn} do
    {:ok, lv, html} = live(conn, ~p"/agents")
    refute html =~ "running…"

    # What a script (the roster cron, at 07:00) does — insert a running row
    # plus events, with this already-open console never involved.
    run_id = run!("scout", "running")
    event!(run_id, 0, "assistant_text", %{"text" => "heartbeat picked this up"})

    send(lv.pid, :heartbeat)
    html = render(lv)

    assert html =~ "scout running…"
    assert html =~ "run in progress…"
    assert html =~ "heartbeat picked this up"
  end

  test "a stray heartbeat tick while a tail is already armed does not reload the page", %{
    conn: conn
  } do
    run!("scout", "running")

    {:ok, lv, html} = live(conn, ~p"/agents")
    assert html =~ "scout running…"
    assert html =~ "$0.00</span>"

    # Only a fresh load/1 would pick this up — the tell-tale for whether the
    # stray tick below actually reloaded (a double-arm) or was the no-op
    # idle?/1 is supposed to make it while a tail already owns the job.
    Repo.query!("""
    INSERT INTO localfinds.runs (agent, started_at, status, cost_usd)
    VALUES ('curator', now() - interval '1 day', 'success', 5.00)
    """)

    send(lv.pid, :heartbeat)
    html = render(lv)

    assert html =~ "scout running…"
    assert html =~ "$0.00</span>"
    refute html =~ "$5.00</span>"
  end

  test "after a run ends, the heartbeat resumes and picks up a subsequent externally-started run",
       %{conn: conn} do
    run_id_1 = run!("scout", "running")

    {:ok, lv, html} = live(conn, ~p"/agents")
    assert html =~ "scout running…"

    # End run 1 the same way tail_test.exs does: a run_end event, the row
    # flipping out of "running", then the tail's own tick discovering it.
    event!(run_id_1, 0, "run_end", %{"status" => "success"})

    Repo.query!(
      "UPDATE localfinds.runs SET status = 'success', finished_at = now() WHERE id = $1",
      [
        run_id_1
      ]
    )

    send(lv.pid, {:run_tail, run_id_1})

    html = render(lv)
    refute html =~ "running…"

    # A second, entirely external run starts. Nothing is watching this
    # socket except whatever poller run 1 ending handed control back to.
    run_id_2 = run!("curator", "running")
    event!(run_id_2, 0, "assistant_text", %{"text" => "second run picked up"})

    send(lv.pid, :heartbeat)
    html = render(lv)

    assert html =~ "curator running…"
    assert html =~ "second run picked up"
  end

  test "a DB bounce during a heartbeat tick degrades instead of crashing" do
    # No mocking dependency exists in this project (see run_tail_test.exs's
    # own note on the identical limitation for on_tick/3), so this forces a
    # genuine DBConnection.ConnectionError the way DB.guard/1 actually sees
    # one in production: a real Ecto.Repo pool pointed at an address nothing
    # is listening on. put_dynamic_repo/1 scopes this to the calling
    # process only — the shared pool every other (possibly concurrent) test
    # uses is untouched — which is also why handle_info/2 is called directly
    # here rather than through a mounted LiveView: that call must run in
    # *this* process for the dynamic repo override to apply to it.
    {:ok, broken_pid} =
      Localfinds.Repo.start_link(
        name: :heartbeat_test_broken_repo,
        url: "postgres://localfinds:localfinds@127.0.0.1:1/localfinds_test",
        pool_size: 1,
        timeout: 200,
        connect_timeout: 100,
        queue_target: 50,
        queue_interval: 50
      )

    # A hard kill, not GenServer.stop/1: this pool's connections are mid
    # reconnect-attempt against a refused port, and a graceful stop's
    # terminate/2 walk of that supervision tree exits with :shutdown rather
    # than :normal, which GenServer.stop/3 (via :proc_lib.stop/3) surfaces as
    # a test failure. Nothing here needs a clean shutdown — it's a throwaway
    # pool that never held a real connection.
    on_exit(fn -> Process.exit(broken_pid, :kill) end)

    Localfinds.Repo.put_dynamic_repo(:heartbeat_test_broken_repo)

    socket =
      %Phoenix.LiveView.Socket{}
      |> Phoenix.Component.assign(:starting, nil)
      |> Phoenix.Component.assign(:active_run, nil)
      |> Phoenix.Component.assign(:db_unavailable, false)

    assert {:noreply, new_socket} =
             LocalfindsWeb.AgentsLive.Index.handle_info(:heartbeat, socket)

    Localfinds.Repo.put_dynamic_repo(Localfinds.Repo)

    assert new_socket.assigns.db_unavailable
  end

  describe "real-timer canaries" do
    # heartbeat_ms/0 reads Application.get_env(:localfinds, :heartbeat_ms, 5_000)
    # at call time, so shrinking it here reaches mount/3 and every handle_info/2
    # clause in the LiveView process too — Application env is node-global, not
    # process-local (unlike the dynamic-repo trick in the DB-bounce test above).
    # Restored on exit so no other test file inherits a fast heartbeat.
    #
    # Small enough that every sleep below (a "neutralize the leftover mount
    # timer" wait, plus settle/0) comfortably finishes inside @await_poll_ms
    # (250ms, real, unconfigurable) — see the "await giving up" test's own
    # comment for why that margin specifically matters here.
    @canary_heartbeat_ms 20

    setup do
      Application.put_env(:localfinds, :heartbeat_ms, @canary_heartbeat_ms)
      on_exit(fn -> Application.delete_env(:localfinds, :heartbeat_ms) end)
      :ok
    end

    defp settle, do: Process.sleep(@canary_heartbeat_ms * 5)

    test "mount really schedules a heartbeat when idle — nothing is hand-sent", %{conn: conn} do
      {:ok, lv, html} = live(conn, ~p"/agents")
      refute html =~ "running…"

      run_id = run!("scout", "running")
      event!(run_id, 0, "assistant_text", %{"text" => "picked up by the real timer"})

      # No send/2 anywhere in this test — if mount/3's own
      # `|> resume_polling()` were ever deleted, nothing would ever notice
      # this insert and the assertions below would time out into failure.
      settle()
      html = render(lv)

      assert html =~ "scout running…"
      assert html =~ "picked up by the real timer"
    end

    test "a run ending really resumes the heartbeat afterward — nothing is hand-sent past that point",
         %{conn: conn} do
      run_id_1 = run!("scout", "running")
      {:ok, lv, html} = live(conn, ~p"/agents")
      assert html =~ "scout running…"

      # Driving {:run_tail, run_id} by hand here is fine — it isolates the
      # done_fun's own `|> resume_polling()` specifically, rather than also
      # depending on RunTail's real 700ms cadence to reach it. What must NOT
      # be hand-sent is anything after this point.
      event!(run_id_1, 0, "run_end", %{"status" => "success"})

      Repo.query!(
        "UPDATE localfinds.runs SET status = 'success', finished_at = now() WHERE id = $1",
        [run_id_1]
      )

      send(lv.pid, {:run_tail, run_id_1})
      refute render(lv) =~ "running…"

      run_id_2 = run!("curator", "running")
      event!(run_id_2, 0, "assistant_text", %{"text" => "picked up by the real timer"})

      settle()
      html = render(lv)

      assert html =~ "curator running…"
      assert html =~ "picked up by the real timer"
    end

    test "await giving up really resumes the heartbeat afterward — nothing is hand-sent past that point",
         %{conn: conn} do
      {:ok, lv, _html} = live(conn, ~p"/agents")

      lv |> element(~s{button[phx-value-target="scout"]}) |> render_click()
      assert_receive {:spawned, "scout"}

      # Two different real timers are outstanding right after this click, and
      # both must be accounted for before the assertions below can mean what
      # they claim to:
      #
      # 1. mount/3 already scheduled its own idle heartbeat before this click
      #    (nothing was running yet). Left alone, it would fire *after*
      #    :starting clears below and look identical to this test's own
      #    give-up branch having resumed polling — indistinguishable from the
      #    outside. Waiting it out here, while :starting is still non-nil
      #    (idle?/1 false, so any tick is forced into a no-op that does NOT
      #    reschedule itself), empties it out for good.
      # 2. The click itself scheduled the real {:await_run, "scout", deadline}
      #    at @await_poll_ms (250ms, real, unconfigurable) — hand-sending a
      #    *second*, already-expired one below only fast-forwards through
      #    this specific branch once; it does not cancel that first, still-
      #    pending real one, which keeps its own real deadline (20s away) and
      #    will independently re-check fresh_in_progress?/0 when it fires.
      #    Everything from here to the final assertion must complete before
      #    that real 250ms mark, or that unrelated tick — not this test's
      #    hand-driven one — could be what a broken resume_polling/1 here
      #    gets covered by.
      Process.sleep(@canary_heartbeat_ms * 2)

      past_deadline = System.monotonic_time(:millisecond) - 1
      send(lv.pid, {:await_run, "scout", past_deadline})
      refute render(lv) =~ "starting…"

      run_id = run!("scout", "running")
      event!(run_id, 0, "assistant_text", %{"text" => "picked up by the real timer"})

      settle()
      html = render(lv)

      # @canary_heartbeat_ms * 2 (neutralize) + @canary_heartbeat_ms * 5
      # (settle) = 140ms at the configured 20ms — comfortably inside the
      # click's real 250ms window, so the assertions below land before the
      # real chain's first re-check could possibly interfere (see above).
      assert html =~ "scout running…"
      assert html =~ "picked up by the real timer"
    end

    test "await landing really arms the real tail timer — nothing is hand-sent at all", %{
      conn: conn
    } do
      {:ok, lv, _html} = live(conn, ~p"/agents")

      lv |> element(~s{button[phx-value-target="scout"]}) |> render_click()
      assert_receive {:spawned, "scout"}

      run_id = run!("scout", "running")

      # No hand-sent {:await_run, ...} here on purpose. A hand-sent one would
      # drive the landed branch itself, but the *real* one — scheduled by the
      # click above, firing at @await_poll_ms (250ms, real) — is separately
      # and unavoidably still pending regardless, and re-checks
      # fresh_in_progress?/0 on its own: an earlier draft of this test sent a
      # duplicate and it passed even with resume_polling/1 deleted from this
      # branch, because that real message's own (unconditional) load/1 call
      # picked up the row anyway. Waiting for the one real message to fire —
      # and be the *only* thing that ever reaches this branch — is what
      # actually isolates it.
      Process.sleep(500)
      refute render(lv) =~ "starting…"
      assert render(lv) =~ "scout running…"

      event!(run_id, 0, "assistant_text", %{"text" => "picked up by the real tail timer"})

      Process.sleep(LocalfindsWeb.RunTail.interval_ms() * 3)
      html = render(lv)

      assert html =~ "picked up by the real tail timer"
    end
  end
end
