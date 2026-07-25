defmodule Localfinds.DB do
  @moduledoc """
  One place that decides which database failures are "the server is bouncing"
  (degrade honestly) and which are bugs (raise).

  The shared udl Postgres restarts roughly weekly when apt upgrades the
  postgresql-15 packages, which drops every pooled connection. A request in
  flight should render an honest "temporarily unavailable", not a 500 — but a
  permission error or a bad query must still blow up loudly.
  """

  @shutdown_codes [:admin_shutdown, :crash_shutdown, :cannot_connect_now]

  @spec guard((-> result)) :: {:ok, result} | {:error, :database_unavailable} when result: var
  def guard(fun) when is_function(fun, 0) do
    {:ok, fun.()}
  rescue
    DBConnection.ConnectionError ->
      {:error, :database_unavailable}

    e in Postgrex.Error ->
      case e.postgres do
        %{code: code} when code in @shutdown_codes -> {:error, :database_unavailable}
        _ -> reraise e, __STACKTRACE__
      end
  end
end
