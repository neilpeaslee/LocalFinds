defmodule LocalfindsWeb.EndpointTest do
  @moduledoc """
  `socket "/live", ...` in endpoint.ex used to mount only `websocket:`.
  Phoenix's `socket/3` defaults `:longpoll` to `false`, so `/live/longpoll` had
  no route and 404'd — meaning a visitor whose browser genuinely needs the
  fallback (a websocket-hostile proxy) got a dead page, not a working
  long-poll connection. This is defence in depth, not the map-mount fix
  itself: the fix is not shipping ~3.7MB in the connected mount's join reply
  in the first place, so a healthy websocket's first ping round-trips before
  Phoenix ever re-arms its fallback timer.
  """
  use LocalfindsWeb.ConnCase, async: true

  test "/live/longpoll is a mounted transport, not a 404", %{conn: conn} do
    conn = get(conn, "/live/longpoll")

    refute conn.status == 404
    assert Enum.any?(get_resp_header(conn, "content-type"), &(&1 =~ "application/json"))
  end

  describe "robots.txt" do
    setup do
      %{body: File.read!(Path.join(:code.priv_dir(:localfinds), "static/robots.txt"))}
    end

    test "is served over HTTP", %{conn: conn} do
      conn = get(conn, "/robots.txt")
      assert response(conn, 200) =~ "User-agent"
    end

    test "is not the stock all-commented file", %{body: body} do
      assert body =~ ~r/^Disallow:/m
    end

    test "disallows the faceted query-string space", %{body: body} do
      assert body =~ "Disallow: /*?"
      assert body =~ "Disallow: /places?"
      assert body =~ "Disallow: /feed?"
      assert body =~ "Disallow: /sources?"
    end

    test "blocks the AI crawlers seen in the access log", %{body: body} do
      for agent <- ~w(GPTBot Google-Extended meta-externalagent Amazonbot CCBot ClaudeBot) do
        assert body =~ "User-agent: #{agent}", "expected #{agent} to be blocked"
      end
    end

    # The whole point of blocking Google-Extended rather than Googlebot: AI
    # training is opted out of, search indexing is not. A future edit that adds
    # Googlebot to the block list would silently de-index the site.
    test "does NOT block Googlebot", %{body: body} do
      refute body =~ ~r/^User-agent: Googlebot\s*$/m
    end
  end
end
