defmodule LocalfindsWeb.DBComponents do
  @moduledoc """
  The standard "the database is bouncing" state, so every ported page degrades
  identically instead of each one inventing its own copy.
  """
  use Phoenix.Component

  attr :class, :string, default: nil

  def db_unavailable(assigns) do
    ~H"""
    <p class={["py-12 text-center text-sm text-stone-500", @class]}>
      Temporarily unavailable — the database is restarting. Try again in a moment.
    </p>
    """
  end
end
