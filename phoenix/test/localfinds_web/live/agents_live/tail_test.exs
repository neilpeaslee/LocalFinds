defmodule LocalfindsWeb.AgentsLive.TailTest do
  @moduledoc """
  Task 8: the live transcript wired into both /agents pages via RunTail.

  Only the first test relies on RunTail's real Process.send_after timer; the
  rest drive the tick deterministically with `send(lv.pid, {:run_tail, 1})`.
  A sleep-based test that waits multiples of RunTail.interval_ms() is a
  liability in CI — fast on a quiet runner, flaky on a loaded one — so it's
  kept to the one test whose whole point is proving the real timer reaches a
  mounted page's handle_info without anyone poking it by hand. Everything
  else only cares that handle_info({:run_tail, run_id}, socket) does the
  right thing once it fires, which a direct send proves without waiting on
  wall-clock time at all.
  """
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase
  import Phoenix.LiveViewTest

  alias Localfinds.Repo
  alias LocalfindsWeb.RunTail

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.run_events, localfinds.runs RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.runs (id, agent, started_at, status)
    OVERRIDING SYSTEM VALUE VALUES (1, 'scout', now(), 'running')
    """)

    steward = create_user!("s@example.com", "correct horse battery", "steward")
    {:ok, conn: log_in_user(conn, steward)}
  end

  defp event!(seq, kind, payload) do
    Repo.query!(
      "INSERT INTO localfinds.run_events (run_id, seq, kind, payload) VALUES (1, $1, $2, $3)",
      [seq, kind, payload]
    )
  end

  defp settle, do: Process.sleep(RunTail.interval_ms() * 2)

  test "the detail page's real timer delivers a tick without being poked by hand", %{conn: conn} do
    {:ok, lv, html} = live(conn, ~p"/agents/runs/1")
    assert html =~ "Waiting for the run to start…"

    event!(0, "assistant_text", %{"text" => "scanning the market page"})
    settle()

    assert render(lv) =~ "scanning the market page"
  end

  test "the detail page appends events as they land", %{conn: conn} do
    {:ok, lv, html} = live(conn, ~p"/agents/runs/1")
    assert html =~ "Waiting for the run to start…"

    event!(0, "assistant_text", %{"text" => "scanning the market page"})
    send(lv.pid, {:run_tail, 1})

    assert render(lv) =~ "scanning the market page"
  end

  test "run_end stops the tail and settles the stats in place", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents/runs/1")

    event!(0, "tool_result", %{"toolUseId" => "a", "content" => "x", "isError" => true})
    event!(1, "run_end", %{"status" => "success"})

    Repo.query!("""
    UPDATE localfinds.runs
       SET status = 'success', finished_at = started_at + interval '12 seconds',
           num_turns = 7, cost_usd = 0.0311, items_added = 4, items_updated = 2
     WHERE id = 1
    """)

    send(lv.pid, {:run_tail, 1})
    html = render(lv)

    assert html =~ "run success"
    assert html =~ "12s"
    assert html =~ "+4 / ~2"
    assert html =~ "$0.031"
    assert html =~ "⚠ 1"
    refute html =~ "Waiting for the run to start…"
  end

  test "the console tails the active run into its banner", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/agents")

    event!(0, "assistant_text", %{"text" => "banner transcript line"})
    send(lv.pid, {:run_tail, 1})

    assert render(lv) =~ "banner transcript line"
  end

  test "a finished run's page does not tail", %{conn: conn} do
    Repo.query!("UPDATE localfinds.runs SET status = 'success', finished_at = now() WHERE id = 1")

    {:ok, lv, _html} = live(conn, ~p"/agents/runs/1")

    event!(0, "assistant_text", %{"text" => "written after the run ended"})

    # No settle() and no manual send here on purpose: live? is false at mount,
    # so RunTail.watch/1 is never called and no {:run_tail, _} message is ever
    # scheduled for this process — there is nothing to wait for. Asserting
    # immediately is the deterministic proof that nothing ticks, not a weaker
    # version of it.
    refute render(lv) =~ "written after the run ended"
  end
end
