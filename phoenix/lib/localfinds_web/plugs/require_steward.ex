defmodule LocalfindsWeb.Plugs.RequireSteward do
  @moduledoc """
  Halts with an empty 401 unless the current scope holds a steward. Sits behind
  nginx auth_request, which reads only the status — so no body, no redirect.
  """
  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    case conn.assigns[:current_scope] do
      %{user: %{role: "steward"}} -> conn
      _ -> conn |> send_resp(401, "") |> halt()
    end
  end
end
