defmodule LocalfindsWeb.AgentsLive.TriggerTest do
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase
  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.run_events, localfinds.runs RESTART IDENTITY CASCADE")
    Application.put_env(:localfinds, :spawner_test_pid, self())

    on_exit(fn ->
      Application.delete_env(:localfinds, :spawner_test_pid)
      Application.delete_env(:localfinds, :spawner_result)
    end)

    steward = create_user!("s@example.com", "correct horse battery", "steward")
    {:ok, conn: log_in_user(conn, steward)}
  end

  test "clicking Run spawns that agent and shows an immediate acknowledgement", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    html = lv |> element(~s{button[phx-value-target="scout"]}) |> render_click()

    assert_receive {:spawned, "scout"}
    assert html =~ "starting…"
  end

  test "Run all spawns the whole roster", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    lv |> element(~s{button[phx-value-target="all"]}) |> render_click()

    assert_receive {:spawned, "all"}
  end

  test "it does not block waiting for the run row to appear", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    {micros, _} =
      :timer.tc(fn -> lv |> element(~s{button[phx-value-target="scout"]}) |> render_click() end)

    # The reference polls up to 20s here. Anything near that means the blocking
    # wait was ported by mistake.
    assert micros < 2_000_000
  end

  test "a live run refuses a new trigger", %{conn: conn} do
    Repo.query!("""
    INSERT INTO localfinds.runs (agent, started_at, status)
    VALUES ('scout', now(), 'running')
    """)

    {:ok, lv, _html} = live(conn, ~p"/agents")

    render_click(lv, "trigger", %{"target" => "curator"})

    refute_receive {:spawned, _}, 200
  end

  test "an unknown target is refused without spawning", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    render_click(lv, "trigger", %{"target" => "concierge"})
    render_click(lv, "trigger", %{"target" => "../../etc/passwd"})

    refute_receive {:spawned, _}, 200
  end

  test "a spawn failure tells the steward", %{conn: conn} do
    Application.put_env(:localfinds, :spawner_result, {:error, :no_data_dir})

    {:ok, lv, _html} = live(conn, ~p"/agents")
    html = lv |> element(~s{button[phx-value-target="scout"]}) |> render_click()

    assert html =~ "Could not start the run"
  end

  test "a non-steward scope cannot spawn even with a socket in hand" do
    # The mount gate makes this unreachable through the router; the handler's
    # own check is the defence if a scope ever changes mid-session.
    socket =
      %Phoenix.LiveView.Socket{}
      |> Phoenix.Component.assign(:current_scope, Localfinds.Accounts.Scope.for_user(nil))
      |> Phoenix.Component.assign(:runs, [])
      |> Phoenix.Component.assign(:now, DateTime.utc_now())
      |> Phoenix.Component.assign(:starting, nil)

    LocalfindsWeb.AgentsLive.Index.handle_event("trigger", %{"target" => "scout"}, socket)

    refute_receive {:spawned, _}, 200
  end

  # --- Post-review fix: the in-progress guard was blind to the run it just
  # started, because Runs.in_progress?/2 reads a cached :runs list that is
  # only refreshed once the :await_run poll (or an existing tail) reloads it.
  # A second click landing inside that window reached Spawner.run/1 a second
  # time. These three tests cover the fix: the :starting-based guard closes
  # the hole at click time (no reload required), the await restores the
  # promised "banner appears once the row lands" behaviour off the click's
  # critical path, and the await gives up cleanly on a spawn that never
  # produces a row.

  test "a second trigger for a different agent is refused while the first spawn is still starting",
       %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    lv |> element(~s{button[phx-value-target="scout"]}) |> render_click()
    assert_receive {:spawned, "scout"}

    # No row exists yet at this point — the real CLI hasn't started, so a
    # fresh database read alone would see nothing running and let this
    # through. The guard must already be closed by :starting alone, before
    # any row lands.
    render_click(lv, "trigger", %{"target" => "curator"})

    refute_receive {:spawned, "curator"}, 200

    # What the real CLI would do moments later, inserted only now to show it
    # was never load-bearing for the refusal above.
    Repo.query!("""
    INSERT INTO localfinds.runs (agent, started_at, status)
    VALUES ('scout', now(), 'running')
    """)
  end

  test "once the running row lands, :starting clears and the banner takes over", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    lv |> element(~s{button[phx-value-target="scout"]}) |> render_click()
    assert_receive {:spawned, "scout"}

    Repo.query!("""
    INSERT INTO localfinds.runs (agent, started_at, status)
    VALUES ('scout', now(), 'running')
    """)

    # Drives the poll directly instead of waiting @await_poll_ms in real time
    # — deterministic, and proves handle_info({:await_run, ...}) does the
    # right thing on its own once fired, same as tail_test.exs's
    # send(lv.pid, {:run_tail, run_id}) pattern.
    deadline = System.monotonic_time(:millisecond) + 20_000
    send(lv.pid, {:await_run, "scout", deadline})
    html = render(lv)

    refute html =~ "starting…"
    assert html =~ "scout running…"
    assert html =~ "run in progress…"
  end

  test "the await gives up cleanly when no row ever appears, and the button recovers", %{
    conn: conn
  } do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    lv |> element(~s{button[phx-value-target="scout"]}) |> render_click()
    assert_receive {:spawned, "scout"}

    # A deadline already in the past, rather than sleeping the real
    # @await_budget_ms (20s) in CI — the point under test is what happens
    # once the deadline has passed, not the wall-clock wait to get there.
    past_deadline = System.monotonic_time(:millisecond) - 1
    send(lv.pid, {:await_run, "scout", past_deadline})
    html = render(lv)

    refute html =~ "starting…"

    # Stronger than a text assertion: the guard itself must have released,
    # not just the label — a fresh click reaches Spawner.run/1 again.
    render_click(lv, "trigger", %{"target" => "scout"})
    assert_receive {:spawned, "scout"}
  end

  # --- Final-review fix: the guard's fresh-read half. already_starting_or_running?/1
  # used to fall back on socket.assigns.runs — a cache refreshed only by load/1
  # (mount, an armed tail's done_fun, or this socket's own :await_run poll). A
  # socket that mounted with nothing running, and that never itself triggers a
  # run whose poll would refresh that cache, never reloads :runs again for the
  # life of the connection: every scenario below reached Spawner.run/1 a
  # second time under the old guard even though a run was genuinely live,
  # because nothing on this particular socket had ever re-read the database.

  test "a run started outside this console (the roster cron, or another steward) blocks a fresh trigger",
       %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    # Nothing was running at mount, so this socket's cached :runs is []. The
    # cron (not this socket) starts scout a moment later.
    Repo.query!("""
    INSERT INTO localfinds.runs (agent, started_at, status)
    VALUES ('scout', now(), 'running')
    """)

    render_click(lv, "trigger", %{"target" => "all"})

    refute_receive {:spawned, _}, 200
  end

  test "once the await gives up, a click that lands after the CLI's row finally appears still refuses",
       %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    lv |> element(~s{button[phx-value-target="scout"]}) |> render_click()
    assert_receive {:spawned, "scout"}

    # The spawn is slow enough that the await budget elapses first — driven
    # directly with a past deadline rather than sleeping the real 20s.
    past_deadline = System.monotonic_time(:millisecond) - 1
    send(lv.pid, {:await_run, "scout", past_deadline})
    html = render(lv)
    refute html =~ "starting…"

    # The real CLI's row lands a moment after the timeout gave up on it —
    # unlike the "gives up cleanly" test above, this time the row does show
    # up, just too late for :starting to have caught it. Nothing on this
    # socket reloads :runs on its own, so without a fresh read the guard
    # would still see the stale empty list from mount and let a second click
    # through — permanently, since no further reload is ever coming.
    Repo.query!("""
    INSERT INTO localfinds.runs (agent, started_at, status)
    VALUES ('scout', now(), 'running')
    """)

    render_click(lv, "trigger", %{"target" => "scout"})

    refute_receive {:spawned, _}, 200
  end

  test "a second browser tab refuses a trigger once the first tab's spawn has landed", %{
    conn: conn
  } do
    {:ok, lv_a, _html} = live(conn, ~p"/agents")
    {:ok, lv_b, _html} = live(conn, ~p"/agents")

    lv_a |> element(~s{button[phx-value-target="scout"]}) |> render_click()
    assert_receive {:spawned, "scout"}

    # Tab A's own row lands. Tab B is a separate LiveView process with its
    # own :runs cache, still whatever it saw at its own mount — before this
    # row existed — and its own :starting, which was never set.
    Repo.query!("""
    INSERT INTO localfinds.runs (agent, started_at, status)
    VALUES ('scout', now(), 'running')
    """)

    render_click(lv_b, "trigger", %{"target" => "curator"})

    refute_receive {:spawned, "curator"}, 200
  end
end
