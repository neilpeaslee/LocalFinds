defmodule Localfinds.MapCategoriesTest do
  use ExUnit.Case, async: true

  alias Localfinds.MapCategories

  setup do
    dir =
      Path.join(System.tmp_dir!(), "map_categories_test_#{System.unique_integer([:positive])}")

    File.mkdir_p!(Path.join(dir, "config"))
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  defp write!(dir, name, body), do: File.write!(Path.join([dir, "config", name]), body)

  test "load/0 reads the fixture config the test env points at" do
    cfg = MapCategories.load()
    assert length(cfg.themes) == 4
    assert cfg.other_key == "other"
    assert cfg.other_label == "Other"
    assert cfg.other_color == "#a8a29e"
  end

  test "theme_of/2: an exact kind match wins" do
    cfg = MapCategories.load()

    assert MapCategories.theme_of(cfg, "tourism=museum") == %{
             key: "arts",
             label: "Arts & Culture",
             color: "#ec4899",
             subtype: "Museum",
             subtype_key: "tourism=museum"
           }
  end

  test "theme_of/2: a key=* wildcard matches any value and reports the wildcard key" do
    cfg = MapCategories.load()
    match = MapCategories.theme_of(cfg, "shop=supermarket")
    assert match.key == "retail"
    assert match.subtype == "Shop"
    assert match.subtype_key == "shop=*"
  end

  test "theme_of/2: an unmatched kind falls back to Other with no sub-type" do
    cfg = MapCategories.load()

    for kind <- ["office=lawyer", "craft=sawmill", nil, ""] do
      assert MapCategories.theme_of(cfg, kind) == %{
               key: "other",
               label: "Other",
               color: "#a8a29e",
               subtype: nil,
               subtype_key: nil
             }
    end
  end

  test "legend_themes/1 appends the Other entry, matching page.tsx's mapThemes" do
    cfg = MapCategories.load()
    legend = MapCategories.legend_themes(cfg)
    assert length(legend) == 5
    assert List.last(legend) == %{key: "other", label: "Other", color: "#a8a29e"}
    assert hd(legend) == %{key: "outdoors", label: "Outdoors & Rec", color: "#10b981"}
  end

  test "an unreadable dir falls back to a permissive default — everything is Other", %{dir: dir} do
    cfg = MapCategories.load(Path.join(dir, "does-not-exist"))
    assert cfg.themes == []
    assert MapCategories.theme_of(cfg, "tourism=museum").key == "other"
    assert MapCategories.theme_of(cfg, "tourism=museum").color == "#64748b"
  end

  test "malformed JSON falls through to the .example template", %{dir: dir} do
    write!(dir, "map-categories.json", "{ not json")

    write!(dir, "map-categories.json.example", ~s({
      "themes": [{"key": "civic", "label": "Civic", "color": "#3b82f6",
                  "subtypes": {"amenity=library": "Library"}}],
      "otherKey": "misc", "otherLabel": "Misc", "otherColor": "#111111"
    }))

    cfg = MapCategories.load(dir)
    assert MapCategories.theme_of(cfg, "amenity=library").subtype == "Library"
    assert MapCategories.theme_of(cfg, "shop=books").key == "misc"
  end

  test "when the same key appears in two themes, the first listed wins", %{dir: dir} do
    write!(dir, "map-categories.json", ~s({
      "themes": [
        {"key": "first",  "label": "First",  "color": "#111", "subtypes": {"amenity=cafe": "A"}},
        {"key": "second", "label": "Second", "color": "#222", "subtypes": {"amenity=cafe": "B"}}
      ]
    }))

    assert MapCategories.theme_of(MapCategories.load(dir), "amenity=cafe").key == "first"
  end

  test "a theme with no subtypes map is tolerated, not a crash", %{dir: dir} do
    write!(dir, "map-categories.json", ~s({
      "themes": [{"key": "bare", "label": "Bare", "color": "#333"}]
    }))

    cfg = MapCategories.load(dir)
    assert MapCategories.theme_of(cfg, "amenity=cafe").key == "other"

    assert MapCategories.legend_themes(cfg) |> hd() == %{
             key: "bare",
             label: "Bare",
             color: "#333"
           }
  end
end
