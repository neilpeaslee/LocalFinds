defmodule Localfinds.TagFacetsTest do
  use ExUnit.Case, async: true

  alias Localfinds.TagFacets

  describe "linkable?/1" do
    test "categorical keys are linkable" do
      assert TagFacets.linkable?("amenity=cafe")
      assert TagFacets.linkable?("shop=bakery")
      assert TagFacets.linkable?("cuisine=pizza")
      assert TagFacets.linkable?("tourism=hotel")
      assert TagFacets.linkable?("leisure=park")
    end

    # These are the keys that created the crawl space. Named individually so a
    # future edit to the allowlist that readmits one fails loudly here.
    test "per-place and contact keys are not linkable" do
      refute TagFacets.linkable?("way_area=498.736")
      refute TagFacets.linkable?("name=Joe's Diner")
      refute TagFacets.linkable?("phone=+1 207 555 0100")
      refute TagFacets.linkable?("email=hello@example.test")
      refute TagFacets.linkable?("website=https://example.test")
      refute TagFacets.linkable?("addr:street=Main Street")
      refute TagFacets.linkable?("opening_hours=Mo-Fr 09:00-17:00")
      refute TagFacets.linkable?("wikidata=Q42")
    end

    test "the key is everything before the FIRST =, so values containing = are safe" do
      assert TagFacets.linkable?("amenity=cafe=weird")
      refute TagFacets.linkable?("website=https://x.test/?a=b")
    end

    test "malformed input does not crash and is not linkable" do
      refute TagFacets.linkable?("amenity")
      refute TagFacets.linkable?("=cafe")
      refute TagFacets.linkable?("")
      refute TagFacets.linkable?("=")
    end

    test "matching is exact, not a prefix" do
      refute TagFacets.linkable?("amenity_type=cafe")
      refute TagFacets.linkable?("disused:amenity=cafe")
    end

    test "non-binary input types do not crash and are not linkable" do
      refute TagFacets.linkable?(nil)
      refute TagFacets.linkable?(:amenity)
      refute TagFacets.linkable?(42)
    end
  end
end
