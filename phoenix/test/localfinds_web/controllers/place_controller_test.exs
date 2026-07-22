defmodule LocalfindsWeb.PlaceControllerTest do
  use LocalfindsWeb.ConnCase, async: true

  @contract_keys ~w(address brand kind lat lng name osm_id phone tags town website)

  defp authed(conn), do: put_req_header(conn, "authorization", "Bearer test-token")

  test "missing token is 401 with the error shape", %{conn: conn} do
    conn = get(conn, ~p"/osm/places?town=Rockland")
    assert %{"error" => _} = json_response(conn, 401)
  end

  test "wrong token is 401", %{conn: conn} do
    conn =
      conn
      |> put_req_header("authorization", "Bearer wrong")
      |> get(~p"/osm/places?town=Rockland")

    assert json_response(conn, 401)
  end

  test "list returns a bare array with exactly the 11 contract keys", %{conn: conn} do
    conn = authed(conn) |> get(~p"/osm/places?town=Rockland")
    places = json_response(conn, 200)
    assert is_list(places) and length(places) == 7
    assert places |> hd() |> Map.keys() |> Enum.sort() == @contract_keys
  end

  test "tags is the full jsonb object", %{conn: conn} do
    conn = authed(conn) |> get(~p"/osm/places/node/1")
    place = json_response(conn, 200)
    assert place["tags"]["amenity"] == "cafe"
    assert place["tags"]["cuisine"] == "coffee_shop"
  end

  test "validation failures surface as 400 with {\"error\": msg}", %{conn: conn} do
    for query <- [
          "town=Rockland&bbox=44,-69,45,-68",
          "bbox=44,-69,45",
          "town=Rockland&keys=natural",
          "town=Rockland&limit=0"
        ] do
      conn2 = authed(conn) |> get("/osm/places?" <> query)
      assert %{"error" => _} = json_response(conn2, 400), "expected 400 for #{query}"
    end
  end

  test "detail 404s on missing and malformed ids", %{conn: conn} do
    for path <- ["/osm/places/node/999999", "/osm/places/bogus", "/osm/places/node"] do
      conn2 = authed(conn) |> get(path)
      assert %{"error" => "not found"} = json_response(conn2, 404), "expected 404 for #{path}"
    end
  end

  test "database_unavailable maps to 503 (fallback unit)", %{conn: conn} do
    conn = LocalfindsWeb.FallbackController.call(conn, {:error, :database_unavailable})
    assert conn.status == 503
  end
end
