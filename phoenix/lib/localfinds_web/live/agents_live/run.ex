defmodule LocalfindsWeb.AgentsLive.Run do
  @moduledoc "One agent run: stats and transcript. Steward-only."
  use LocalfindsWeb, :live_view

  @impl true
  def mount(_params, _session, socket) do
    {:ok, assign(socket, :page_title, "Run")}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="flex flex-col gap-4"></div>
    """
  end
end
