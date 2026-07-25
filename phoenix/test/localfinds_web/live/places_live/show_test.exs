defmodule LocalfindsWeb.PlacesLive.ShowTest do
  use LocalfindsWeb.ConnCase, async: false

  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup do
    Repo.query!("TRUNCATE localfinds.place_annotations RESTART IDENTITY CASCADE")
    :ok
  end

  test "renders the facts for a multi-segment osm id", %{conn: conn} do
    {:ok, _lv, html} = live(conn, "/places/node/1")

    assert html =~ "Rock City Coffee"
    assert html =~ "amenity=cafe"
    assert html =~ "chain: Rock City"
    assert html =~ "https://rockcity.example"
    assert html =~ "Rockland"
    assert html =~ "T3"
    assert html =~ "active"
  end

  test "links a real osm id out to openstreetmap.org", %{conn: conn} do
    {:ok, _lv, html} = live(conn, "/places/way/12")
    assert html =~ ~s(href="https://www.openstreetmap.org/way/12")
  end

  test "a custom place shows its id as provenance text, not an OSM link", %{conn: conn} do
    {:ok, _lv, html} = live(conn, "/places/custom/1")
    assert html =~ "custom/1"
    refute html =~ "openstreetmap.org/custom/1"
    assert html =~ "Added by LocalFinds"
  end

  test "tag chips link back into the filtered list", %{conn: conn} do
    {:ok, _lv, html} = live(conn, "/places/node/11")
    assert html =~ "craft=sawmill"
    assert html =~ "/places?tag=craft%3Dsawmill"
  end

  test "renders the annotation note as sanitized markdown", %{conn: conn} do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, note, added_by) VALUES ('way/12', '## Summer\n\nGreat <script>alert(1)</script> spot', 'test')"
    )

    {:ok, _lv, html} = live(conn, "/places/way/12")
    assert html =~ "<h2>Summer</h2>"
    refute html =~ "<script>alert(1)</script>"
  end

  test "shows the empty-note state when there is no annotation", %{conn: conn} do
    {:ok, _lv, html} = live(conn, "/places/way/12")
    assert html =~ "No note yet."
  end

  test "an effective status override is what the badge shows", %{conn: conn} do
    Repo.query!(
      "INSERT INTO localfinds.place_annotations (osm_id, status_override, added_by) VALUES ('way/2', 'closed', 'test')"
    )

    {:ok, _lv, html} = live(conn, "/places/way/2")
    assert html =~ "closed"
  end

  test "an unknown place 404s", %{conn: conn} do
    assert_raise LocalfindsWeb.NotFoundError, fn -> live(conn, "/places/node/999999") end
  end

  test "the back link returns to the list", %{conn: conn} do
    {:ok, _lv, html} = live(conn, "/places/way/12")
    assert html =~ "← Back to places"
  end
end
