defmodule LocalfindsWeb.HomeLive.IndexTest do
  use LocalfindsWeb.ConnCase, async: false

  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.finds RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.finds (title, url, url_hash, summary, type, agent, tags, status, discovered_at)
    VALUES
      ('Harbor Concert', 'https://e.test/1', 'h1', 'Music on the water.', 'event',  'scout', '{"music"}', 'new', now() - interval '1 minute'),
      ('Second Find',    'https://e.test/2', 'h2', 'Another one.',        'deal',   'scout', '{"food"}',  'new', now() - interval '2 minutes'),
      ('Third Find',     'https://e.test/3', 'h3', NULL,                  'notice', 'scout', '{}',        'new', now() - interval '3 minutes'),
      ('Fourth Find',    'https://e.test/4', 'h4', NULL,                  'notice', 'scout', '{}',        'new', now() - interval '4 minutes'),
      ('Fifth Find',     'https://e.test/5', 'h5', NULL,                  'notice', 'scout', '{}',        'new', now() - interval '5 minutes'),
      ('Sixth Find',     'https://e.test/6', 'h6', NULL,                  'notice', 'scout', '{}',        'new', now() - interval '6 minutes'),
      ('Seventh Find',   'https://e.test/7', 'h7', NULL,                  'notice', 'scout', '{}',        'new', now() - interval '7 minutes')
    """)

    {:ok, conn: conn}
  end

  test "renders the region name and its coverage prose as markdown", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/")
    assert html =~ "Coverage"
    assert html =~ "<strong>midcoast</strong>"
    refute html =~ "Seed sources"
  end

  test "renders the three stats", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/")
    assert html =~ "towns covered"
    assert html =~ "places catalogued"
    assert html =~ "current finds"
  end

  test "the towns-covered stat counts the config towns, not DB rows", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/")
    # towns.json fixture has two valid towns (a third is malformed and dropped).
    assert html =~ ~r/2\s*<\/span>\s*<span>towns covered/
  end

  test "the current-finds stat counts the whole feed, not the six shown", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/")
    assert html =~ ~r/7\s*<\/span>\s*<span>current finds/
  end

  test "shows at most six find cards", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/")
    assert html =~ "Harbor Concert"
    assert html =~ "Sixth Find"
    refute html =~ "Seventh Find"
  end

  test "links through to the full feed", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/")
    assert html =~ ~s(href="/feed")
    assert html =~ "View all"
  end

  test "the empty state carries no sysops instruction", %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.finds RESTART IDENTITY CASCADE")
    {:ok, _lv, html} = live(conn, ~p"/")

    assert html =~ "No current finds"
    # The Next reference told every visitor to run `npm run agents:all`. That is
    # ops signal in user-facing copy, and it has been wrong since agents moved
    # to cron on the box. If this ever fails, the deviation was reverted.
    refute html =~ "npm run"
    refute html =~ "agents:all"
  end

  test "a healthy page is not flagged as degraded", %{conn: conn} do
    {:ok, lv, html} = live(conn, ~p"/")
    refute html =~ "Temporarily unavailable"
    refute :sys.get_state(lv.pid).socket.assigns.db_unavailable
  end

  describe "the map container" do
    test "the disconnected render shows the placeholder and ships no pin data", %{conn: conn} do
      html = conn |> get(~p"/") |> html_response(200)

      assert html =~ "Loading map…"
      refute html =~ "phx-hook=\"RegionMap\""
      refute html =~ "data-pins"
    end

    test "the connected render mounts the hook with pins", %{conn: conn} do
      {:ok, _lv, html} = live(conn, ~p"/")

      assert html =~ ~s(phx-hook="RegionMap")
      assert html =~ ~s(id="region-map")
      assert html =~ "Farnsworth Art Museum"
      refute html =~ "Loading map…"
    end

    test "the hook element is marked phx-update=ignore", %{conn: conn} do
      {:ok, _lv, html} = live(conn, ~p"/")
      # Without this a re-render patches the DOM Leaflet owns and wipes the tiles.
      assert html =~ ~s(phx-update="ignore")
    end

    test "excluded places are absent from the pin payload", %{conn: conn} do
      {:ok, _lv, html} = live(conn, ~p"/")
      refute html =~ "Hannaford"
      refute html =~ "Rock City Coffee"
    end

    test "the legend lists every theme plus Other and the coverage swatch", %{conn: conn} do
      {:ok, _lv, html} = live(conn, ~p"/")

      assert html =~ "Coverage area"
      assert html =~ "Arts &amp; Culture"
      assert html =~ "Other"
      assert html =~ "more (zoom in)"
    end

    test "boundaries and towns reach the hook as data attributes", %{conn: conn} do
      {:ok, _lv, html} = live(conn, ~p"/")
      assert html =~ "data-boundaries"
      assert html =~ "data-towns"
      assert html =~ "Rockland"
    end
  end
end
