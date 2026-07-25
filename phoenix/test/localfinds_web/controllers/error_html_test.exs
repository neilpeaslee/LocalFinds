defmodule LocalfindsWeb.ErrorHTMLTest do
  use LocalfindsWeb.ConnCase, async: true

  import Phoenix.Template, only: [render_to_string: 4]

  test "renders 404" do
    assert render_to_string(LocalfindsWeb.ErrorHTML, "404", "html", []) =~ "Not Found"
  end

  test "renders 500" do
    assert render_to_string(LocalfindsWeb.ErrorHTML, "500", "html", []) =~ "Internal Server Error"
  end
end
