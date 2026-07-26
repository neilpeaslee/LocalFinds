defmodule LocalfindsWeb.AgentsLive.IndexTest do
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

  defp insert_run!(sql), do: Repo.query!(sql)

  test "renders a section for every roster agent even with no runs", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/agents")

    for agent <- Localfinds.Runs.roster() do
      assert html =~ agent
    end

    assert html =~ "No runs yet."
  end

  test "renders the 30-day spend", %{conn: conn} do
    insert_run!("""
    INSERT INTO localfinds.runs (agent, started_at, status, cost_usd)
    VALUES ('scout', now() - interval '2 days', 'success', 1.25)
    """)

    {:ok, _lv, html} = live(conn, ~p"/agents")
    assert html =~ "$1.25"
  end

  test "renders a run row with its counts, duration and cost", %{conn: conn} do
    insert_run!("""
    INSERT INTO localfinds.runs
      (agent, started_at, finished_at, status, items_added, items_updated, num_turns, cost_usd)
    VALUES
      ('scout', now() - interval '1 hour', now() - interval '1 hour' + interval '42 seconds',
       'success', 3, 1, 12, 0.0125)
    """)

    {:ok, _lv, html} = live(conn, ~p"/agents")

    assert html =~ "success"
    assert html =~ "42s"
    assert html =~ "+3 / ~1"
    assert html =~ "$0.013"
  end

  test "a stale running row reads as likely crashed and does not disable the buttons", %{
    conn: conn
  } do
    insert_run!("""
    INSERT INTO localfinds.runs (agent, started_at, status)
    VALUES ('scout', now() - interval '30 minutes', 'running')
    """)

    {:ok, _lv, html} = live(conn, ~p"/agents")

    assert html =~ "running — likely crashed"
    refute html =~ "run in progress…"
  end

  test "a live running row disables the buttons and shows the banner", %{conn: conn} do
    insert_run!("""
    INSERT INTO localfinds.runs (agent, started_at, status)
    VALUES ('curator', now() - interval '1 minute', 'running')
    """)

    {:ok, _lv, html} = live(conn, ~p"/agents")

    assert html =~ "run in progress…"
    assert html =~ "curator running…"
    assert html =~ "disabled"
  end

  test "a non-roster agent with runs gets a read-only section", %{conn: conn} do
    insert_run!("""
    INSERT INTO localfinds.runs (agent, started_at, status)
    VALUES ('concierge', now() - interval '3 hours', 'success')
    """)

    {:ok, _lv, html} = live(conn, ~p"/agents")

    assert html =~ "concierge"
    # Exactly one Run button per roster agent, plus "Run all" — concierge adds none.
    buttons = html |> String.split(~s(phx-click="trigger")) |> length() |> Kernel.-(1)
    assert buttons == length(Localfinds.Runs.roster()) + 1
  end

  test "each run links to its detail page", %{conn: conn} do
    insert_run!("""
    INSERT INTO localfinds.runs (id, agent, started_at, status)
    OVERRIDING SYSTEM VALUE VALUES (42, 'scout', now(), 'success')
    """)

    {:ok, _lv, html} = live(conn, ~p"/agents")
    assert html =~ ~s(href="/agents/runs/42")
  end
end
