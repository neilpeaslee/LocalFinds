defmodule LocalfindsWeb.LiveDBTest do
  use ExUnit.Case, async: true

  alias LocalfindsWeb.LiveDB

  defp socket, do: %Phoenix.LiveView.Socket{}

  test "assigns the value and marks the page healthy" do
    s = LiveDB.load(socket(), :rows, fn -> [:a] end, [])
    assert s.assigns.rows == [:a]
    refute s.assigns.db_unavailable
  end

  test "assigns the fallback and flags degradation when the DB is down" do
    s = LiveDB.load(socket(), :rows, fn -> raise DBConnection.ConnectionError, "down" end, [])
    assert s.assigns.rows == []
    assert s.assigns.db_unavailable
  end

  test "a later successful load does not clear an earlier failure" do
    s =
      socket()
      |> LiveDB.load(:towns, fn -> raise DBConnection.ConnectionError, "down" end, [])
      |> LiveDB.load(:rows, fn -> [:a] end, [])

    assert s.assigns.rows == [:a]
    assert s.assigns.db_unavailable
  end
end
