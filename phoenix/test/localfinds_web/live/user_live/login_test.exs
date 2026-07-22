defmodule LocalfindsWeb.UserLive.LoginTest do
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase

  import Phoenix.LiveViewTest

  describe "login page" do
    test "renders login page", %{conn: conn} do
      {:ok, _lv, html} = live(conn, ~p"/auth/log-in")

      assert html =~ "Log in"
    end
  end

  describe "user login - password" do
    test "redirects if user logs in with valid credentials", %{conn: conn} do
      user = create_user!("foo@example.com", "correct horse battery")

      {:ok, lv, _html} = live(conn, ~p"/auth/log-in")

      form =
        form(lv, "#login_form_password",
          user: %{email: user.email, password: "correct horse battery", remember_me: true}
        )

      conn = submit_form(form, conn)

      assert redirected_to(conn) == ~p"/auth/log-in"
    end

    test "redirects to login page with a flash error if credentials are invalid", %{
      conn: conn
    } do
      {:ok, lv, _html} = live(conn, ~p"/auth/log-in")

      form =
        form(lv, "#login_form_password", user: %{email: "test@email.com", password: "123456"})

      render_submit(form, %{user: %{remember_me: true}})

      conn = follow_trigger_action(form, conn)
      assert Phoenix.Flash.get(conn.assigns.flash, :error) == "Invalid email or password"
      assert redirected_to(conn) == ~p"/auth/log-in"
    end
  end
end
