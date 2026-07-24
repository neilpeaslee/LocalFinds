defmodule LocalfindsWeb.Realtime do
  @moduledoc """
  Realtime-ready seam for the UI port (rung 3). Every ported LiveView calls
  `subscribe/1` under `connected?/1` in mount and carries a
  `handle_info({:realtime, _}, socket)` fallback. Dormant now — rung 4 fills in
  the PubSub topics and update handling here without restructuring the pages.
  """
  def subscribe(socket), do: socket
end
