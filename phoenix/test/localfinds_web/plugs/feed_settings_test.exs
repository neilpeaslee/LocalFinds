defmodule LocalfindsWeb.Plugs.FeedSettingsTest do
  use LocalfindsWeb.ConnCase, async: true

  alias Localfinds.FeedSettings
  # Aliased, not imported as `Plug`: that name is taken by Plug itself, and
  # `Plug.Test.init_test_session/2` is needed in the same function.
  alias LocalfindsWeb.Plugs.FeedSettings, as: FeedSettingsPlug

  defp run(conn) do
    conn
    |> Plug.Test.init_test_session(%{})
    |> FeedSettingsPlug.call(FeedSettingsPlug.init([]))
  end

  test "copies the cookie into the session verbatim", %{conn: conn} do
    raw = FeedSettings.to_cookie(%{FeedSettings.defaults() | page_size: 25})
    conn = conn |> put_req_cookie("lf_settings", raw) |> run()

    assert get_session(conn, "lf_settings") == raw
  end

  test "stores nothing when there is no cookie", %{conn: conn} do
    conn = run(conn)
    assert get_session(conn, "lf_settings") == nil
  end

  test "passes a junk cookie through untouched — parsing is not its job", %{conn: conn} do
    conn = conn |> put_req_cookie("lf_settings", "not json") |> run()
    assert get_session(conn, "lf_settings") == "not json"
  end

  test "an implausibly large cookie is skipped, not copied", %{conn: conn} do
    oversize = String.duplicate("a", 3500)
    conn = conn |> put_req_cookie("lf_settings", oversize) |> run()

    # Treated exactly like an absent cookie: nothing lands in the session. A
    # verbatim copy this size would risk pushing the signed session past
    # Plug's 4096-byte Set-Cookie limit (Plug.Conn.CookieOverflowError -> 500)
    # once Plug.Session encodes the response — which this plug must never do,
    # on any page in the shared :browser pipeline, not just /feed.
    assert get_session(conn, "lf_settings") == nil
  end

  test "an oversize cookie does not overwrite an existing in-bounds session value", %{
    conn: conn
  } do
    small = FeedSettings.to_cookie(%{FeedSettings.defaults() | page_size: 100})
    oversize = String.duplicate("a", 3500)

    conn =
      conn
      |> Plug.Test.init_test_session(%{"lf_settings" => small})
      |> put_req_cookie("lf_settings", oversize)
      |> FeedSettingsPlug.call(FeedSettingsPlug.init([]))

    assert get_session(conn, "lf_settings") == nil
  end
end
