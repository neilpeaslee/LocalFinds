defmodule Localfinds.DBTest do
  use ExUnit.Case, async: true

  alias Localfinds.DB

  test "wraps a successful read" do
    assert DB.guard(fn -> [1, 2, 3] end) == {:ok, [1, 2, 3]}
  end

  test "a dropped connection degrades instead of raising" do
    assert DB.guard(fn -> raise DBConnection.ConnectionError, "connection not available" end) ==
             {:error, :database_unavailable}
  end

  test "a server shutdown degrades instead of raising" do
    # Postgrex.Error.exception/1 expects `postgres.code` to be the raw
    # SQLSTATE string from the wire (e.g. "57P01"), which it then translates
    # into the friendly atom (:admin_shutdown) via Postgrex.ErrorCode — the
    # same atom DB.guard/1 matches on. Class 57 = operator intervention.
    for sqlstate <- ["57P01", "57P02", "57P03"] do
      fun = fn ->
        raise Postgrex.Error,
          postgres: %{code: sqlstate, message: "shutting down", severity: "FATAL"}
      end

      assert DB.guard(fun) == {:error, :database_unavailable}
    end
  end

  test "any other Postgres error still raises — degradation must not hide bugs" do
    fun = fn ->
      raise Postgrex.Error, postgres: %{code: "42501", message: "nope", severity: "ERROR"}
    end

    assert_raise Postgrex.Error, fn -> DB.guard(fun) end
  end
end
