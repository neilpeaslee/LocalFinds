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
end
