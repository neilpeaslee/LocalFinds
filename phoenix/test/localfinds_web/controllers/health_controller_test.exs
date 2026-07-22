defmodule LocalfindsWeb.HealthControllerTest do
  use LocalfindsWeb.ConnCase, async: true

  test "health is unauthenticated and green when the pool is up", %{conn: conn} do
    conn = get(conn, ~p"/health")
    assert %{"ok" => true} = json_response(conn, 200)
  end
end
