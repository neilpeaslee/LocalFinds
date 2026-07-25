defmodule LocalfindsWeb.NotFoundError do
  @moduledoc "Raised by a LiveView when the requested record does not exist."
  defexception message: "not found", plug_status: 404
end
