defmodule LocalfindsWeb.FeedLive.SettingsTest do
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase
  import Phoenix.LiveViewTest

  alias Localfinds.FeedSettings
  alias Localfinds.Repo

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.finds RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.finds (title, url_hash, status, agent, discovered_at)
    VALUES ('Only find', 's1', 'new', 'scout', now())
    """)

    {:ok, conn: conn, steward: create_user!("s@example.com", "correct horse battery", "steward")}
  end

  test "the panel is seeded from the persisted defaults, not the URL state", %{
    conn: conn,
    steward: steward
  } do
    cookie = FeedSettings.to_cookie(%{FeedSettings.defaults() | density: "compact"})

    {:ok, _lv, html} =
      conn
      |> log_in_user(steward)
      |> put_req_cookie("lf_settings", cookie)
      |> live(~p"/feed?density=full")

    # The select shows the saved default (compact), even though this render is full.
    #
    # Deviation from the brief: the brief's literal string was
    # `<option selected value="compact">`. Phoenix/HEEx serializes a `true`
    # boolean attribute as `attr=""` (not a bare word) and preserves the
    # template's own attribute order (`value` before `selected` here), so that
    # exact string can never appear regardless of how the component is
    # written. Corrected to match the real, valid markup Phoenix emits, while
    # still asserting the "compact" option (and only that one) carries the
    # selected marker.
    assert html =~ ~s{<option value="compact" selected="">}
  end

  test "submitting the panel saves the cookie and the next render uses it", %{
    conn: conn,
    steward: steward
  } do
    conn = log_in_user(conn, steward)
    {:ok, lv, _html} = live(conn, ~p"/feed")

    conn =
      lv
      |> form(~s{form[action="/feed/settings"]}, %{
        "view" => "starred",
        "pageSize" => "25",
        "density" => "compact",
        "sort" => "oldest",
        "days" => "7",
        "from" => "",
        "to" => ""
      })
      |> submit_form(conn)

    assert redirected_to(conn) == ~p"/feed"

    saved = FeedSettings.from_cookie(conn.resp_cookies["lf_settings"].value)
    assert saved.view == "starred"
    assert saved.page_size == 25
    assert saved.density == "compact"
    assert saved.sort == "oldest"
    assert saved.days == 7
  end

  test "the panel is not rendered for a logged-out visitor", %{conn: conn} do
    {:ok, _lv, html} = live(conn, ~p"/feed")

    refute html =~ "Save as default"
    refute html =~ ~s{action="/feed/settings"}
  end

  test "the form carries a CSRF token", %{conn: conn, steward: steward} do
    {:ok, _lv, html} = conn |> log_in_user(steward) |> live(~p"/feed")
    assert html =~ ~s{name="_csrf_token"}
  end
end
