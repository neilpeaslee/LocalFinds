defmodule LocalfindsWeb.Router do
  use LocalfindsWeb, :router

  import LocalfindsWeb.UserAuth

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :bearer do
    plug LocalfindsWeb.Plugs.BearerAuth
  end

  pipeline :gate do
    plug :fetch_session
    plug :fetch_current_scope_for_gate
    plug LocalfindsWeb.Plugs.RequireSteward
  end

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {LocalfindsWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug :fetch_current_scope_for_user
  end

  scope "/", LocalfindsWeb do
    pipe_through :api
    get "/health", HealthController, :show
  end

  scope "/", LocalfindsWeb do
    pipe_through :browser

    live_session :app,
      on_mount: [{LocalfindsWeb.UserAuth, :mount_current_scope}] do
      live "/sources", SourcesLive.Index, :index
    end
  end

  scope "/osm", LocalfindsWeb do
    pipe_through [:api, :bearer]
    get "/places", PlaceController, :index
    get "/places/*osm_id", PlaceController, :show
  end

  scope "/auth", LocalfindsWeb do
    pipe_through :gate
    get "/check", AuthCheckController, :check
  end

  scope "/auth", LocalfindsWeb do
    pipe_through :browser

    live_session :current_user,
      on_mount: [{LocalfindsWeb.UserAuth, :mount_current_scope}] do
      live "/log-in", UserLive.Login, :new
    end

    post "/log-in", UserSessionController, :create
    delete "/log-out", UserSessionController, :delete
  end
end
