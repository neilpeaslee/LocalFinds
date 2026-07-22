defmodule LocalfindsWeb.HealthController do
  use LocalfindsWeb, :controller

  def show(conn, _params) do
    case Localfinds.Repo.query("SELECT 1") do
      {:ok, _} -> json(conn, %{ok: true})
      {:error, _} -> conn |> put_status(503) |> json(%{ok: false})
    end
  end
end
