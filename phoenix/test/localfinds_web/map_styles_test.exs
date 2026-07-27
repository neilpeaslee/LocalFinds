defmodule LocalfindsWeb.MapStylesTest do
  @moduledoc """
  Companion to prose_styles_test.exs, for the same failure mode: the map's
  cluster labels depend on rules that live in the global stylesheet, not in any
  component, so a reviewer reading the page or the hook cannot see them missing.

  Without `.leaflet-tooltip.cluster-count`, Leaflet's default white tooltip box
  renders on top of the cluster bubble and the pins — the map looks broken, and
  no ExUnit assertion on markup would notice.
  """
  use ExUnit.Case, async: true

  @stylesheet Path.expand("../../assets/css/app.css", __DIR__)
  @hook Path.expand("../../assets/js/hooks/region_map.js", __DIR__)
  @vendor Path.expand("../../assets/vendor", __DIR__)

  test "the stylesheet strips Leaflet's tooltip box for cluster counts" do
    css = File.read!(@stylesheet)

    assert css =~ ~r/\.leaflet-tooltip\.cluster-count\s*\{/,
           "the cluster-count rule is gone from assets/css/app.css — " <>
             "Leaflet's default white tooltip box will cover the bubbles and pins"

    assert css =~ ~r/\.leaflet-tooltip\.cluster-count::before\s*\{/,
           "the ::before rule is gone — the tooltip's directional arrow returns"
  end

  test "Leaflet's own stylesheet is imported, not just its JS" do
    assert File.read!(@stylesheet) =~ ~s(@import "../vendor/leaflet.css"),
           "without leaflet.css the tile panes are unpositioned and the map is a jumble"
  end

  test "the hook applies the cluster-count class the stylesheet targets" do
    assert File.read!(@hook) =~ "cluster-count",
           "the rule and the class it targets have drifted apart"
  end

  test "the vendored libraries are present" do
    for file <- ~w(leaflet.js leaflet.css supercluster.min.js) do
      assert File.exists?(Path.join(@vendor, file)), "missing vendored asset: #{file}"
    end
  end
end
