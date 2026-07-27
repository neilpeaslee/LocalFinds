defmodule LocalfindsWeb.AgentsLive.RunTest do
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase
  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.run_events, localfinds.runs RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.runs
      (id, agent, started_at, finished_at, status, items_added, items_updated, num_turns, cost_usd)
    OVERRIDING SYSTEM VALUE
    VALUES (1, 'scout', now() - interval '5 minutes',
            now() - interval '5 minutes' + interval '30 seconds',
            'success', 2, 5, 9, 0.0421)
    """)

    Repo.query!(
      "INSERT INTO localfinds.run_events (run_id, seq, kind, payload) VALUES (1, 0, 'run_start', $1)",
      [%{"agent" => "scout", "runId" => 1, "model" => "opus", "maxTurns" => 30}]
    )

    Repo.query!(
      "INSERT INTO localfinds.run_events (run_id, seq, kind, payload) VALUES (1, 1, 'tool_result', $1)",
      [%{"toolUseId" => "a", "content" => "nope", "isError" => true}]
    )

    steward = create_user!("s@example.com", "correct horse battery", "steward")
    {:ok, conn: log_in_user(conn, steward)}
  end

  test "renders the stat block", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/agents/runs/1")

    assert html =~ "scout · run #1"
    assert html =~ "success"
    assert html =~ "30s"
    assert html =~ "+2 / ~5"
    assert html =~ "$0.042"
    assert html =~ "9"
  end

  test "warnings are computed from the events, not the stored column", %{conn: conn} do
    # The runs row was inserted with the default warnings = 0, but one event is
    # a flagged tool_result — the page must show 1.
    {:ok, _lv, html} = live(conn, ~p"/agents/runs/1")
    assert html =~ "⚠ 1"
  end

  test "renders the transcript", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/agents/runs/1")

    assert html =~ "run started · opus · maxTurns 30"
    assert html =~ "tool error"
  end

  test "links back to the console", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/agents/runs/1")
    assert html =~ "← back to agents"
  end

  test "a stale running run reads as likely crashed", %{conn: conn} do
    Repo.query!("""
    INSERT INTO localfinds.runs (id, agent, started_at, status)
    OVERRIDING SYSTEM VALUE VALUES (2, 'curator', now() - interval '45 minutes', 'running')
    """)

    {:ok, _lv, html} = live(conn, ~p"/agents/runs/2")
    assert html =~ "running — likely crashed"
  end

  test "an unknown or malformed id is a 404", %{conn: conn} do
    assert_raise LocalfindsWeb.NotFoundError, fn -> live(conn, ~p"/agents/runs/999") end
    assert_raise LocalfindsWeb.NotFoundError, fn -> live(conn, ~p"/agents/runs/not-a-number") end
  end

  test "a run with no events says so", %{conn: conn} do
    Repo.query!("""
    INSERT INTO localfinds.runs (id, agent, started_at, status)
    OVERRIDING SYSTEM VALUE VALUES (3, 'curator', now(), 'error')
    """)

    {:ok, _lv, html} = live(conn, ~p"/agents/runs/3")
    assert html =~ "No transcript recorded for this run."
  end
end
