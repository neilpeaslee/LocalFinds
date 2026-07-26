defmodule LocalfindsWeb.AgentsLive.GateTest do
  @moduledoc """
  /agents serves interest profiles — personal-taste PII. The gate is exercised
  two ways on purpose: through the router (the visitor's path) and against the
  on_mount hook directly (the socket's path). nginx can only ever see the
  first, which is why the second exists.
  """
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase
  import Phoenix.LiveViewTest

  alias LocalfindsWeb.UserAuth

  setup %{conn: conn} do
    {:ok,
     conn: conn,
     steward: create_user!("s@example.com", "correct horse battery", "steward"),
     member: create_user!("m@example.com", "correct horse battery", "member")}
  end

  describe "through the router" do
    test "a logged-out visitor is redirected from both routes", %{conn: conn} do
      assert {:error, {:redirect, %{to: "/auth/log-in"}}} = live(conn, ~p"/agents")
      assert {:error, {:redirect, %{to: "/auth/log-in"}}} = live(conn, ~p"/agents/runs/1")

      assert conn |> get(~p"/agents") |> redirected_to() == ~p"/auth/log-in"
      assert conn |> get(~p"/agents/runs/1") |> redirected_to() == ~p"/auth/log-in"
    end

    test "an authenticated member is redirected too — the gate is steward-only", %{
      conn: conn,
      member: member
    } do
      conn = log_in_user(conn, member)

      assert {:error, {:redirect, %{to: "/auth/log-in"}}} = live(conn, ~p"/agents")
      assert conn |> get(~p"/agents") |> redirected_to() == ~p"/auth/log-in"
    end

    test "a steward gets in", %{conn: conn, steward: steward} do
      assert {:ok, _lv, _html} = live(log_in_user(conn, steward), ~p"/agents")
    end
  end

  describe "the on_mount hook itself" do
    # There is one code path for the disconnected render and the connected
    # mount, so halting here is what closes the socket. Asserting on the hook
    # keeps that provable without a live_session round-trip.
    #
    # A bare %Phoenix.LiveView.Socket{} has no :flash key in assigns, and the
    # halt branch calls put_flash/3 before redirecting — so, matching the
    # house pattern in user_auth_test.exs for :require_authenticated, the
    # halt-path sockets here carry an endpoint and a seeded flash assign.
    defp socket_with_flash do
      %Phoenix.LiveView.Socket{
        endpoint: LocalfindsWeb.Endpoint,
        assigns: %{__changed__: %{}, flash: %{}}
      }
    end

    test "halts with no scope" do
      assert {:halt, _socket} =
               UserAuth.on_mount(:require_steward, %{}, %{}, socket_with_flash())
    end

    test "halts for a member token", %{member: member} do
      token = Localfinds.Accounts.generate_user_session_token(member)

      assert {:halt, _socket} =
               UserAuth.on_mount(
                 :require_steward,
                 %{},
                 %{"user_token" => token},
                 socket_with_flash()
               )
    end

    test "continues for a steward token", %{steward: steward} do
      token = Localfinds.Accounts.generate_user_session_token(steward)

      assert {:cont, socket} =
               UserAuth.on_mount(
                 :require_steward,
                 %{},
                 %{"user_token" => token},
                 %Phoenix.LiveView.Socket{}
               )

      assert UserAuth.steward?(socket.assigns.current_scope)
    end
  end
end
