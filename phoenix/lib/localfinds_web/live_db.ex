defmodule LocalfindsWeb.LiveDB do
  @moduledoc """
  The single read entry point for ported LiveViews:

      socket = LiveDB.load(socket, :rows, fn -> Places.list_directory_places(filters) end, [])

  On success the key is assigned and `@db_unavailable` is false. On a database
  bounce the fallback is assigned (so templates never crash on a missing assign)
  and `@db_unavailable` becomes true — and stays true for the life of the
  LiveView, because a page that already told the visitor it was degraded should
  not silently half-recover on the next patch. A reconnect mounts a fresh
  process and clears it.

  Templates render the degraded state with `<.db_unavailable :if={@db_unavailable} />`
  and guard their body with `:if={!@db_unavailable}`.
  """

  import Phoenix.Component, only: [assign: 3]

  @spec load(Phoenix.LiveView.Socket.t(), atom(), (-> any()), any()) ::
          Phoenix.LiveView.Socket.t()
  def load(socket, key, fun, fallback \\ nil) do
    case Localfinds.DB.guard(fun) do
      {:ok, value} ->
        socket |> assign(key, value) |> ensure_flag()

      {:error, :database_unavailable} ->
        socket |> assign(key, fallback) |> assign(:db_unavailable, true)
    end
  end

  defp ensure_flag(socket) do
    if Map.has_key?(socket.assigns, :db_unavailable) do
      socket
    else
      assign(socket, :db_unavailable, false)
    end
  end
end
