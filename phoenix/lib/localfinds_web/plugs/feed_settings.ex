defmodule LocalfindsWeb.Plugs.FeedSettings do
  @moduledoc """
  Copies the `lf_settings` cookie into the session.

  A LiveView's `mount/3` receives the session and never the conn, so this is the
  only way a plain (non-session) cookie can reach the feed page. The raw string
  is moved verbatim: validation belongs to `Localfinds.FeedSettings`, which the
  page calls, so there is exactly one parser.

  The session is only rewritten when the value actually changed, so ordinary
  page loads do not emit a new session cookie on every response.

  This plug runs in the shared `:browser` pipeline, so it sees every cookie any
  client sends on `/sources`, `/places`, etc. — not just well-formed
  `lf_settings` values written by `FeedSettingsController`. A cookie above
  `@max_cookie_bytes` is skipped rather than copied: the session cookie is
  signed (base64 + MAC overhead), and copying an oversized value in verbatim
  can push the signed session over Plug's 4096-byte `Set-Cookie` limit,
  raising `Plug.Conn.CookieOverflowError` (-> 500) on every page in the
  pipeline, not just `/feed`. 512 bytes is a generous ceiling — neither this
  app nor the Next app ever writes one over ~200. A skipped cookie is treated
  the same as a missing one, so the page falls back to defaults instead of
  erroring.
  """
  import Plug.Conn

  alias Localfinds.FeedSettings

  @max_cookie_bytes 512

  def init(opts), do: opts

  def call(conn, _opts) do
    conn = fetch_cookies(conn)
    raw = bounded(conn.cookies[FeedSettings.cookie_name()])

    if get_session(conn, "lf_settings") == raw do
      conn
    else
      put_session(conn, "lf_settings", raw)
    end
  end

  defp bounded(raw) when is_binary(raw) do
    if byte_size(raw) <= @max_cookie_bytes, do: raw, else: nil
  end

  defp bounded(raw), do: raw
end
