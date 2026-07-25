defmodule LocalfindsWeb.FeedSettingsController do
  @moduledoc """
  The only writer of the `lf_settings` cookie — port of the `saveSettings`
  server action.

  A LiveView cannot set a cookie (the socket has no response to attach one to),
  so the settings panel stays a real HTML form posting here. Steward-only,
  matching the Next app exactly, where the same save is a POST and therefore
  already behind nginx's write gate.

  `Plugs.RequireSteward` is deliberately not reused: it sends a bodyless 401 for
  nginx's `auth_request`, which is the wrong answer for a browser form.
  """
  use LocalfindsWeb, :controller

  alias Localfinds.FeedSettings
  alias LocalfindsWeb.UserAuth

  # A year, site-wide, unsigned, and NOT `secure` — matching what the Next app
  # writes, so the cookie survives a rollback and still works over plain http in
  # local development.
  @cookie_opts [max_age: 60 * 60 * 24 * 365, path: "/", same_site: "Lax", http_only: true]

  def update(conn, params) do
    if UserAuth.steward?(conn.assigns[:current_scope]) do
      conn = fetch_cookies(conn)
      current = FeedSettings.from_cookie(conn.cookies[FeedSettings.cookie_name()])
      next = FeedSettings.from_form(params, current)

      conn
      |> put_resp_cookie(FeedSettings.cookie_name(), FeedSettings.to_cookie(next), @cookie_opts)
      |> redirect(to: ~p"/feed")
    else
      conn
      |> put_flash(:error, "Log in as a steward to save defaults.")
      |> redirect(to: ~p"/feed")
    end
  end
end
