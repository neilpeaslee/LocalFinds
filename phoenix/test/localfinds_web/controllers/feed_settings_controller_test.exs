defmodule LocalfindsWeb.FeedSettingsControllerTest do
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase

  alias Localfinds.FeedSettings

  setup do
    %{
      steward: create_user!("steward@example.com", "correct horse battery", "steward"),
      member: create_user!("member@example.com", "correct horse battery", "member")
    }
  end

  defp saved_cookie(conn), do: conn.resp_cookies["lf_settings"].value

  describe "POST /feed/settings as a steward" do
    test "persists the submitted defaults and redirects", %{conn: conn, steward: steward} do
      conn =
        conn
        |> log_in_user(steward)
        |> post(~p"/feed/settings", %{
          "view" => "starred",
          "pageSize" => "25",
          "density" => "compact",
          "sort" => "soonest",
          "days" => "7",
          "from" => "",
          "to" => ""
        })

      assert redirected_to(conn) == ~p"/feed"

      assert FeedSettings.from_cookie(saved_cookie(conn)) == %{
               view: "starred",
               days: 7,
               from: nil,
               to: nil,
               page_size: 25,
               density: "compact",
               sort: "soonest"
             }
    end

    test "junk values fall back per field, not wholesale", %{conn: conn, steward: steward} do
      existing = FeedSettings.to_cookie(%{FeedSettings.defaults() | view: "starred"})

      conn =
        conn
        |> log_in_user(steward)
        |> put_req_cookie("lf_settings", existing)
        |> post(~p"/feed/settings", %{"view" => "bogus", "density" => "compact"})

      saved = FeedSettings.from_cookie(saved_cookie(conn))

      assert saved.view == "starred"
      assert saved.density == "compact"
    end

    test "a submitted range clears a persisted window", %{conn: conn, steward: steward} do
      existing = FeedSettings.to_cookie(%{FeedSettings.defaults() | days: 30})

      conn =
        conn
        |> log_in_user(steward)
        |> put_req_cookie("lf_settings", existing)
        |> post(~p"/feed/settings", %{"from" => "2026-07-01", "to" => "2026-07-31"})

      saved = FeedSettings.from_cookie(saved_cookie(conn))

      assert saved.from == "2026-07-01"
      assert saved.days == nil
    end

    test "the cookie is long-lived, site-wide and unsigned", %{conn: conn, steward: steward} do
      conn = conn |> log_in_user(steward) |> post(~p"/feed/settings", %{"density" => "compact"})
      cookie = conn.resp_cookies["lf_settings"]

      assert cookie.max_age == 60 * 60 * 24 * 365
      assert cookie.path == "/"
      assert cookie.same_site == "Lax"
      # Unsigned: the value decodes on its own, which is what keeps a rollback
      # to the Next page able to read it.
      assert FeedSettings.from_cookie(cookie.value).density == "compact"
    end
  end

  describe "POST /feed/settings without a steward" do
    test "a member is refused and no cookie is written", %{conn: conn, member: member} do
      conn = conn |> log_in_user(member) |> post(~p"/feed/settings", %{"density" => "compact"})

      assert redirected_to(conn) == ~p"/feed"
      refute conn.resp_cookies["lf_settings"]
      assert Phoenix.Flash.get(conn.assigns.flash, :error) =~ "steward"
    end

    test "a logged-out visitor is refused", %{conn: conn} do
      conn = post(conn, ~p"/feed/settings", %{"density" => "compact"})

      assert redirected_to(conn) == ~p"/feed"
      refute conn.resp_cookies["lf_settings"]
    end
  end
end
