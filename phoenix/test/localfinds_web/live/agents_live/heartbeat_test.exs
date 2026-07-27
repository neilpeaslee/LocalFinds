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

  handle_info(:heartbeat, socket) in index.ex is the fix: a slow (5s), cheap
  (Runs.running/0, not the full load/1) idle-state poll that hands off to the
  real RunTail the moment a run actually appears, and to nothing at all
  whenever a tail or an :await_run poll already owns that job. Every test
  here drives it with a direct `send(lv.pid, :heartbeat)` rather than
  sleeping @heartbeat_ms in real time — deterministic, matching
  tail_test.exs's own house style for RunTail's ticks.
  """
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase
  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.run_events, localfinds.runs RESTART IDENTITY CASCADE")
    steward = create_user!("s@example.com", "correct horse battery", "steward")
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
end
