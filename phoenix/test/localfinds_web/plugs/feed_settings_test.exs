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
end
