defmodule LocalfindsWeb.Router do
  use LocalfindsWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", LocalfindsWeb do
    pipe_through :api
  end
end
