defmodule LocalfindsWeb.AgentsLive.Index do
  @moduledoc "The agents console. Steward-only — see UserAuth.on_mount(:require_steward)."
  use LocalfindsWeb, :live_view

  @impl true
  def mount(_params, _session, socket) do
    {:ok, assign(socket, :page_title, "Agents")}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="flex flex-col gap-6"></div>
    """
  end
end
