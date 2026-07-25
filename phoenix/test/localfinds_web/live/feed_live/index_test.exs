defmodule LocalfindsWeb.FeedLive.IndexTest do
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase
  import Phoenix.LiveViewTest

  alias Localfinds.FeedSettings
  alias Localfinds.Repo

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.feedback, localfinds.finds RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.finds
      (id, title, url, url_hash, summary, status, agent, discovered_at, event_start, tags, type, score)
    OVERRIDING SYSTEM VALUE
    VALUES
      (1, 'Fiddle night', 'https://alpha.test/1', 'f1', 'A summary line', 'new', 'scout',
       now() - interval '1 hour', now() + interval '2 days', '{music}', 'event', NULL),
      (2, 'Bake sale', 'https://alpha.test/2', 'f2', NULL, 'shown', 'scout',
       now() - interval '2 days', now() + interval '9 days', '{food}', 'event', NULL),
      (3, 'A promising lead', NULL, 'f3', NULL, 'new', 'prospector',
       now() - interval '3 days', NULL, '{}', 'lead', 0.82),
      (4, 'Old starred thing', NULL, 'f4', NULL, 'starred', 'scout',
       now() - interval '10 days', NULL, '{}', 'event', NULL),
      (5, 'Buried thing', NULL, 'f5', NULL, 'hidden', 'scout',
       now() - interval '10 days', NULL, '{}', 'event', NULL)
    """)

    {:ok, conn: conn, steward: create_user!("s@example.com", "correct horse battery", "steward")}
  end

  defp with_defaults(conn, patch) do
    put_req_cookie(
      conn,
      "lf_settings",
      FeedSettings.to_cookie(Map.merge(FeedSettings.defaults(), patch))
    )
  end

  test "renders the current finds, newest first", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed")

    assert html =~ "Fiddle night"
    assert html =~ "Bake sale"
    refute html =~ "Buried thing"
    assert html =~ "4 finds"
  end

  test "renders the summary and the agent attribution", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed")

    assert html =~ "A summary line"
    assert html =~ "via scout"
  end

  test "a non-event find shows its type badge and fit score", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed")
    assert html =~ "fit 82%"
  end

  test "the starred view narrows to starred finds", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/feed")
    html = lv |> element("a", "Starred") |> render_click()

    assert html =~ "Old starred thing"
    refute html =~ "Fiddle night"
  end

  test "a tag chip filters the list", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed?tag=food")

    assert html =~ "Bake sale"
    refute html =~ "Fiddle night"
  end

  test "the type row filters by find type", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed?type=lead")

    assert html =~ "A promising lead"
    refute html =~ "Bake sale"
  end

  test "compact density drops the summary", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed?density=compact")
    refute html =~ "A summary line"
  end

  test "cookie defaults apply with no URL params", %{conn: conn} do
    conn = with_defaults(conn, %{view: "starred"})
    {:ok, _lv, html} = live(conn, ~p"/feed")

    assert html =~ "Old starred thing"
    refute html =~ "Fiddle night"
  end

  test "a URL param overrides the cookie default", %{conn: conn} do
    conn = with_defaults(conn, %{view: "starred"})
    {:ok, _lv, html} = live(conn, ~p"/feed?view=default")

    assert html =~ "Fiddle night"
  end

  test "paging slices the list and renders a pager", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed?size=25&page=1")
    refute html =~ "aria-current=\"page\""

    # ?size= only recognizes the page-size vocabulary (25/50/100/all, per
    # LocalfindsWeb.Pagination); a raw "2" falls back to the default (50), so
    # forcing a second page needs enough rows to overflow the smallest real
    # size (25) rather than an out-of-vocabulary value.
    Repo.query!("""
    INSERT INTO localfinds.finds (id, title, url_hash, status, agent, discovered_at, type)
    OVERRIDING SYSTEM VALUE
    SELECT n, 'Extra find ' || n, 'extra' || n, 'new', 'scout', now() - (n || ' minutes')::interval, 'event'
    FROM generate_series(10, 34) AS n
    """)

    {:ok, _lv, html} = live(conn, ~p"/feed?size=25")
    assert html =~ "Showing 1–25 of 29 finds"
    assert html =~ "aria-current=\"page\""
  end

  test "the event date range renders on a dated find", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed")

    expected =
      Calendar.strftime(DateTime.add(DateTime.utc_now(), 2 * 86_400, :second), "%b %-d, %Y")

    assert html =~ expected
  end

  test "the place link is absent when a find has no place", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed")
    refute html =~ "Place ↗"
  end

  test "the empty state carries no operator instructions", %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.finds RESTART IDENTITY CASCADE")
    {:ok, _lv, html} = live(conn, ~p"/feed")

    assert html =~ "Nothing here. Try adjusting the filters, or check back soon."
    refute html =~ "npm run"
  end

  test "a logged-out visitor gets no write controls at all", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed")

    refute html =~ "phx-click=\"feedback\""
  end

  test "a steward gets the per-find action row", %{conn: conn, steward: steward} do
    {:ok, _lv, html} = conn |> log_in_user(steward) |> live(~p"/feed")

    assert html =~ "phx-click=\"feedback\""
    assert html =~ "☆ Star"
  end

  test "a healthy page is not flagged as degraded", %{conn: conn} do
    {:ok, lv, html} = live(conn, ~p"/feed")

    refute html =~ "Temporarily unavailable"
    refute :sys.get_state(lv.pid).socket.assigns.db_unavailable
  end
end
