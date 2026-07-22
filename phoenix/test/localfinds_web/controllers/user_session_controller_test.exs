defmodule LocalfindsWeb.UserSessionControllerTest do
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase

  setup do
    %{user: create_user!("foo@example.com", "correct horse battery")}
  end

  describe "POST /auth/log-in - email and password" do
    test "logs the user in", %{conn: conn, user: user} do
      conn =
        post(conn, ~p"/auth/log-in", %{
          "user" => %{"email" => user.email, "password" => "correct horse battery"}
        })

      assert get_session(conn, :user_token)
      assert redirected_to(conn) == ~p"/auth/log-in"
    end

    test "logs the user in with remember me", %{conn: conn, user: user} do
      conn =
        post(conn, ~p"/auth/log-in", %{
          "user" => %{
            "email" => user.email,
            "password" => "correct horse battery",
            "remember_me" => "true"
          }
        })

      assert conn.resp_cookies["_localfinds_web_user_remember_me"]
      assert redirected_to(conn) == ~p"/auth/log-in"
    end

    test "logs the user in with return to", %{conn: conn, user: user} do
      conn =
        conn
        |> init_test_session(user_return_to: "/foo/bar")
        |> post(~p"/auth/log-in", %{
          "user" => %{
            "email" => user.email,
            "password" => "correct horse battery"
          }
        })

      assert redirected_to(conn) == "/foo/bar"
      assert Phoenix.Flash.get(conn.assigns.flash, :info) =~ "Welcome back!"
    end

    test "redirects to login page with invalid credentials", %{conn: conn, user: user} do
      conn =
        post(conn, ~p"/auth/log-in", %{
          "user" => %{"email" => user.email, "password" => "invalid_password"}
        })

      assert Phoenix.Flash.get(conn.assigns.flash, :error) == "Invalid email or password"
      assert redirected_to(conn) == ~p"/auth/log-in"
    end
  end

  describe "POST /auth/log-in - malformed params" do
    test "redirects instead of crashing when the user param is missing", %{conn: conn} do
      conn = post(conn, ~p"/auth/log-in", %{})
      assert redirected_to(conn) == ~p"/auth/log-in"
    end
  end

  describe "DELETE /auth/log-out" do
    test "logs the user out", %{conn: conn, user: user} do
      conn = conn |> log_in_user(user) |> delete(~p"/auth/log-out")
      assert redirected_to(conn) == ~p"/auth/log-in"
      refute get_session(conn, :user_token)
      assert Phoenix.Flash.get(conn.assigns.flash, :info) =~ "Logged out successfully"
    end

    test "succeeds even if the user is not logged in", %{conn: conn} do
      conn = delete(conn, ~p"/auth/log-out")
      assert redirected_to(conn) == ~p"/auth/log-in"
      refute get_session(conn, :user_token)
      assert Phoenix.Flash.get(conn.assigns.flash, :info) =~ "Logged out successfully"
    end
  end
end
