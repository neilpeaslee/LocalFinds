defmodule LocalfindsWeb.Plugs.FeedSettings do
  @moduledoc """
  Copies the `lf_settings` cookie into the session.

  A LiveView's `mount/3` receives the session and never the conn, so this is the
  only way a plain (non-session) cookie can reach the feed page. The raw string
  is moved verbatim: validation belongs to `Localfinds.FeedSettings`, which the
  page calls, so there is exactly one parser.

  The session is only rewritten when the value actually changed, so ordinary
  page loads do not emit a new session cookie on every response.
  """
  import Plug.Conn

  alias Localfinds.FeedSettings

  def init(opts), do: opts

  def call(conn, _opts) do
    conn = fetch_cookies(conn)
    raw = conn.cookies[FeedSettings.cookie_name()]

    if get_session(conn, "lf_settings") == raw do
      conn
    else
      put_session(conn, "lf_settings", raw)
    end
  end
end
