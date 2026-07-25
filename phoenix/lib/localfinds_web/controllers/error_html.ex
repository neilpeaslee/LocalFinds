defmodule LocalfindsWeb.ErrorHTML do
  @moduledoc """
  Error bodies for HTML requests. The API-only app needed JSON alone; ported UI
  pages must be able to 404 a visitor with something readable.
  """
  use LocalfindsWeb, :html

  def render(template, _assigns) do
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>" <>
      Phoenix.Controller.status_message_from_template(template) <>
      "</title></head><body style=\"font-family:system-ui;padding:2rem\"><h1>" <>
      Phoenix.Controller.status_message_from_template(template) <>
      "</h1><p><a href=\"/\">Back to LocalFinds</a></p></body></html>"
  end
end
