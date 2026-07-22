defmodule LocalfindsWeb.AuthCheckControllerTest do
  use LocalfindsWeb.ConnCase, async: false
  import Localfinds.AuthCase, only: [create_user!: 3]

  alias Localfinds.Accounts

  setup do
    Localfinds.Repo.query!(
      "TRUNCATE localfinds.users_tokens, localfinds.users RESTART IDENTITY CASCADE"
    )
    :ok
  end

  defp with_session(conn, user) do
    token = Accounts.generate_user_session_token(user)

    conn
    |> Plug.Test.init_test_session(%{})
    |> Plug.Conn.put_session(:user_token, token)
  end

  test "anonymous request gets 401 with empty body", %{conn: conn} do
    conn = get(conn, ~p"/auth/check")
    assert conn.status == 401
    assert conn.resp_body == ""
  end

  test "member session gets 401", %{conn: conn} do
    user = create_user!("m@localfinds.me", "member password 1", "member")
    conn = conn |> with_session(user) |> get(~p"/auth/check")
    assert conn.status == 401
  end

  test "steward session gets 200 with empty body", %{conn: conn} do
    user = create_user!("s@localfinds.me", "steward password 1", "steward")
    conn = conn |> with_session(user) |> get(~p"/auth/check")
    assert conn.status == 200
    assert conn.resp_body == ""
  end

  test "revoked session gets 401", %{conn: conn} do
    user = create_user!("s@localfinds.me", "steward password 1", "steward")
    token = Accounts.generate_user_session_token(user)
    :ok = Accounts.delete_user_session_token(token)

    conn =
      conn
      |> Plug.Test.init_test_session(%{})
      |> Plug.Conn.put_session(:user_token, token)
      |> get(~p"/auth/check")

    assert conn.status == 401
  end
end
