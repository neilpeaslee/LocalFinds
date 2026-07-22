defmodule LocalfindsWeb.AuthCheckController do
  use LocalfindsWeb, :controller

  def check(conn, _params), do: send_resp(conn, 200, "")
end
