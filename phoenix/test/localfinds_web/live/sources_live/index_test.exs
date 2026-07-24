defmodule LocalfindsWeb.SourcesLive.IndexTest do
  use LocalfindsWeb.ConnCase, async: false

  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.sources RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.sources (url, name, status, quality_score, finds_count, added_by)
    VALUES
      ('https://alpha.test', 'Alpha', 'active', 4.0, 5, 'test'),
      ('https://bravo.test', 'Bravo', 'dead', NULL, 0, 'test')
    """)

    {:ok, conn: conn}
  end

  test "lists all sources with the summary line", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/sources")
    assert html =~ "Alpha"
    assert html =~ "Bravo"
    assert html =~ "2 sources"
  end

  test "status filter narrows the rows via patch", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/sources")
    html = lv |> element("a", "dead") |> render_click()
    assert html =~ "Bravo"
    refute html =~ "Alpha"
  end

  test "search filters by name", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/sources")

    html =
      lv
      |> form("form", %{"q" => "alpha"})
      |> render_submit()

    assert html =~ "Alpha"
    refute html =~ "Bravo"
  end

  test "renders the empty-state when no sources exist", %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.sources RESTART IDENTITY CASCADE")
    {:ok, _lv, html} = live(conn, ~p"/sources")
    assert html =~ "No sources registered yet"
  end
end
