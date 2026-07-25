defmodule Localfinds.CategoriesTest do
  use ExUnit.Case, async: true

  alias Localfinds.Categories

  setup do
    dir = Path.join(System.tmp_dir!(), "categories_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(dir, "config"))
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  defp write!(dir, name, body), do: File.write!(Path.join([dir, "config", name]), body)

  test "load/0 reads the fixture config the test env points at" do
    cfg = Categories.load()
    assert cfg.default_tier == 3
    assert cfg.hide_tier4
    assert cfg.hide_chains
    assert Categories.tier_of(cfg, "tourism=museum") == 1
    assert Categories.tier_of(cfg, "shop=supermarket") == 4
  end

  test "tier_of/2: exact wins, then key=* wildcard, then the default" do
    cfg = Categories.load()
    assert Categories.tier_of(cfg, "office=lawyer") == 2
    assert Categories.tier_of(cfg, "craft=sawmill") == 2
    assert Categories.tier_of(cfg, "shop=hardware") == 3
    assert Categories.tier_of(cfg, nil) == 3
    assert Categories.tier_of(cfg, "") == 3
  end

  test "an unreadable dir falls back to the permissive default", %{dir: dir} do
    cfg = Categories.load(Path.join(dir, "does-not-exist"))
    assert cfg.default_tier == 3
    assert cfg.hide_tier4
    assert cfg.hide_chains
    assert Categories.tier_of(cfg, "tourism=museum") == 3
  end

  test "malformed JSON falls through to the .example template", %{dir: dir} do
    write!(dir, "categories.json", "{ not json")

    write!(
      dir,
      "categories.json.example",
      ~s({"default_tier": 2, "tiers": {"1": ["shop=books"]}})
    )

    cfg = Categories.load(dir)
    assert cfg.default_tier == 2
    assert Categories.tier_of(cfg, "shop=books") == 1
    assert Categories.tier_of(cfg, "amenity=cafe") == 2
  end

  test "hide_in_directory defaults to true for both flags when absent", %{dir: dir} do
    write!(dir, "categories.json", ~s({"default_tier": 3}))
    cfg = Categories.load(dir)
    assert cfg.hide_tier4
    assert cfg.hide_chains
  end

  test "hide_in_directory flags are read when present", %{dir: dir} do
    write!(dir, "categories.json", ~s({"hide_in_directory": {"tier4": false, "chains": false}}))
    cfg = Categories.load(dir)
    refute cfg.hide_tier4
    refute cfg.hide_chains
  end

  test "a non-numeric default_tier is coerced to 3", %{dir: dir} do
    write!(dir, "categories.json", ~s({"default_tier": "oops"}))
    assert Categories.load(dir).default_tier == 3
  end

  test "a non-numeric tier key is skipped rather than crashing", %{dir: dir} do
    write!(dir, "categories.json", ~s({"tiers": {"one": ["shop=books"], "2": ["shop=gift"]}}))
    cfg = Categories.load(dir)
    assert Categories.tier_of(cfg, "shop=books") == 3
    assert Categories.tier_of(cfg, "shop=gift") == 2
  end
end
