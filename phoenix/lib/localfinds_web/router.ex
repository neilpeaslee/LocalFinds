defmodule LocalfindsWeb.Router do
  use LocalfindsWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :bearer do
    plug LocalfindsWeb.Plugs.BearerAuth
  end

  scope "/", LocalfindsWeb do
    pipe_through :api
    get "/health", HealthController, :show
  end

  scope "/osm", LocalfindsWeb do
    pipe_through [:api, :bearer]
    get "/places", PlaceController, :index
    get "/places/*osm_id", PlaceController, :show
  end
end
