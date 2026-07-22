defmodule LocalfindsWeb.PlaceController do
  use LocalfindsWeb, :controller

  alias Localfinds.Places
  alias Localfinds.Places.Params

  action_fallback LocalfindsWeb.FallbackController

  def index(conn, params) do
    with {:ok, validated} <- Params.validate(params),
         {:ok, places} <- Places.list_places(validated) do
      render(conn, :index, places: places)
    end
  end

  # Wildcard route: params["osm_id"] arrives as path segments, e.g. ["node", "1"].
  def show(conn, %{"osm_id" => segments}) do
    with {:ok, place} <- Places.get_place(Enum.join(segments, "/")) do
      render(conn, :show, place: place)
    end
  end
end
