defmodule LocalfindsWeb.PlacesLive.IndexTest do
  # async: false — some cases write to localfinds.place_annotations.
  use LocalfindsWeb.ConnCase, async: false

  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup do
    Repo.query!("TRUNCATE localfinds.place_annotations RESTART IDENTITY CASCADE")
    :ok
  end

  # Names in render order, read out of the table's name column links.
  defp listed(html) do
    Regex.scan(~r{<a[^>]+href="/places/[^"]+"[^>]*>([^<]+)</a>}, html)
    |> Enum.map(fn [_, name] -> String.trim(name) end)
  end

  test "defaults: hides tier-4 rows and chains, ordered by search priority", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places")

    assert listed(html) == [
             "Farnsworth Art Museum",
             "Harbor Park",
             "Owls Head Light",
             "Coastal Law",
             "Storer Lumber",
             "Test Custom Cafe"
           ]

    assert html =~ "ranked by search priority"
    refute html =~ "Hannaford"
    refute html =~ "Rock City Coffee"
  end

  test "the Show pills expose the hidden counts", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places")
    assert html =~ "chains (1)"
    assert html =~ "excluded categories (1)"
  end

  test "chains=1 reveals chains, which still rank last", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places?chains=1")
    assert List.last(listed(html)) == "Rock City Coffee"
  end

  test "tier4=1 reveals the excluded category", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places?tier4=1")
    assert "Hannaford" in listed(html)
    refute "Rock City Coffee" in listed(html)
  end

  test "the tier badge renders the derived tier", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places?q=Farnsworth")
    assert html =~ "T1"
  end

  test "search filters by name and reports the filtered count", %{conn: conn} do
    {:ok, lv, _html} = live(conn, ~p"/places")

    html = lv |> form("form", %{"q" => "harbor"}) |> render_submit()

    assert listed(html) == ["Harbor Park"]
    assert html =~ "matching filters"
  end

  test "the town pill filters and carries its count", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places")
    assert html =~ "Rockland"

    {:ok, _lv, filtered} = live(conn, ~p"/places?town=Rockland")
    assert length(listed(filtered)) == 6

    {:ok, _lv, none} = live(conn, ~p"/places?town=Camden")
    assert none =~ "No places match these filters."
  end

  test "the tag filter narrows to a single place and offers a clear link", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places?tag=leisure=park")
    assert listed(html) == ["Harbor Park"]
    assert html =~ "clear"
  end

  test "an explicit column sort overrides the ranking and flips direction", %{conn: conn} do
    {:ok, _lv, asc} = live(conn, ~p"/places?sort=name")
    assert listed(asc) == Enum.sort(listed(asc), &(String.downcase(&1) <= String.downcase(&2)))
    assert asc =~ ~s(aria-sort="ascending")
    assert asc =~ "sorted by name (A–Z)"

    {:ok, _lv, desc} = live(conn, ~p"/places?sort=name&dir=desc")
    assert listed(desc) == Enum.reverse(listed(asc))
    assert desc =~ ~s(aria-sort="descending")
  end

  test "rows link to the detail page with the raw osm id", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places?q=Harbor")
    assert html =~ ~s(href="/places/way/12")
  end

  test "the website affordance is labelled for screen readers", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places?chains=1&q=Rock")
    assert html =~ "Visit Rock City Coffee website (opens in a new tab)"
    assert html =~ "chain: Rock City"
  end

  test "no pager renders when everything fits on one page", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places")
    refute html =~ ~s(aria-label="Next page")
  end

  test "size=all reports a plain count instead of a window", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places?size=all")
    assert html =~ "6 places"
    refute html =~ "Showing"
  end

  test "the default page reports its window", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/places")
    assert html =~ "Showing 1–6 of 6 places"
  end
end
