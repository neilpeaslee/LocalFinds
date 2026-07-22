defmodule LocalfindsWeb.HealthController do
  use LocalfindsWeb, :controller

  def show(conn, _params) do
    case Localfinds.Repo.query("SELECT 1") do
      {:ok, _} -> json(conn, %{ok: true})
      {:error, _} -> conn |> put_status(503) |> json(%{ok: false})
    end
  rescue
    # A dead pool raises rather than returning {:error, _} — same failure mode
    # Places rescues. Health is the 503 canary; it must never 500 on a bounce.
    DBConnection.ConnectionError -> conn |> put_status(503) |> json(%{ok: false})
  end
end
