defmodule LocalfindsWeb.SourcesLive.ShowTest do
  use LocalfindsWeb.ConnCase, async: false

  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup do
    Repo.query!("TRUNCATE localfinds.finds, localfinds.sources RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.sources
      (id, url, name, notes_path, status, quality_score, finds_count, added_by, last_checked_at)
    OVERRIDING SYSTEM VALUE
    VALUES (1, 'https://alpha.test', 'Alpha Gazette', 'notes/alpha.md', 'active', 4.25, 2, 'source-keeper', now())
    """)

    Repo.query!("""
    INSERT INTO localfinds.finds (title, url, url_hash, status, agent, source_id)
    VALUES ('Chowder supper', 'https://alpha.test/chowder', 'h1', 'starred', 'scout', 1),
           ('Untitled listing', NULL, 'h2', 'new', 'scout', 1)
    """)

    dir = Path.join(System.tmp_dir!(), "sources_show_test_#{System.unique_integer([:positive])}")
    workspace = Path.join([dir, "agents", "source-keeper", "notes"])
    File.mkdir_p!(workspace)
    File.write!(Path.join(workspace, "alpha.md"), "## Coverage\n\nPosts a weekly calendar.\n")

    previous = Application.get_env(:localfinds, :data_dir)
    Application.put_env(:localfinds, :data_dir, dir)

    on_exit(fn ->
      Application.put_env(:localfinds, :data_dir, previous)
      File.rm_rf!(dir)
    end)

    :ok
  end

  test "renders the source facts and meta line", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/sources/1")

    assert html =~ "Alpha Gazette"
    assert html =~ "https://alpha.test"
    assert html =~ "active"
    assert html =~ "quality 4.2"
    assert html =~ "2 finds"
    assert html =~ "added by source-keeper"
  end

  test "renders the on-disk site note as markdown", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/sources/1")
    assert html =~ "<h2>Coverage</h2>"
    assert html =~ "Posts a weekly calendar."
  end

  test "renders recent finds, linking only those with a url", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/sources/1")

    assert html =~ "Recent finds from this source"
    assert html =~ ~s(href="https://alpha.test/chowder")
    assert html =~ "Untitled listing"
    assert html =~ "starred"
  end

  test "shows the empty-note state when the workspace file is missing", %{conn: conn} do
    Repo.query!("UPDATE localfinds.sources SET notes_path = 'notes/absent.md' WHERE id = 1")
    {:ok, _lv, html} = live(conn, ~p"/sources/1")
    assert html =~ "No site note yet."
  end

  test "falls back to the host when the source has no name", %{conn: conn} do
    Repo.query!("UPDATE localfinds.sources SET name = NULL WHERE id = 1")
    {:ok, _lv, html} = live(conn, ~p"/sources/1")
    assert html =~ "alpha.test"
  end

  test "unknown and non-numeric ids 404", %{conn: conn} do
    assert_raise LocalfindsWeb.NotFoundError, fn -> live(conn, ~p"/sources/999") end
    assert_raise LocalfindsWeb.NotFoundError, fn -> live(conn, "/sources/1abc") end
    assert_raise LocalfindsWeb.NotFoundError, fn -> live(conn, "/sources/0") end
  end

  test "the back link returns to the list", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/sources/1")
    assert html =~ "← Back to sources"
  end
end
