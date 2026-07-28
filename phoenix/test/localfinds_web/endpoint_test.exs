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
end
