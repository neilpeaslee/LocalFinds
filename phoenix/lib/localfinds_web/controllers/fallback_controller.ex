defmodule LocalfindsWeb.FallbackController do
  use LocalfindsWeb, :controller

  def call(conn, {:error, :not_found}) do
    conn |> put_status(404) |> json(%{error: "not found"}) |> halt()
  end

  def call(conn, {:error, :database_unavailable}) do
    conn |> put_status(503) |> json(%{error: "database unavailable"}) |> halt()
  end

  def call(conn, {:error, msg}) when is_binary(msg) do
    conn |> put_status(400) |> json(%{error: msg}) |> halt()
  end
end
