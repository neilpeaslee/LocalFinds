defmodule Localfinds.TownsTest do
  use ExUnit.Case, async: true

  alias Localfinds.Towns

  setup do
    dir = Path.join(System.tmp_dir!(), "towns_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(dir, "config"))
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  defp write!(dir, name, body), do: File.write!(Path.join([dir, "config", name]), body)

  test "load/0 reads the fixture config, dropping the malformed town" do
    towns = Towns.load()
    assert Enum.map(towns, & &1.name) == ["Rockland", "Camden"]
  end

  test "bbox stays [south, west, north, east] and primary defaults to false" do
    [rockland, camden] = Towns.load()
    assert rockland.bbox == [44.05, -69.20, 44.15, -69.05]
    assert rockland.primary
    refute camden.primary
  end

  test "a town whose bbox is not four finite numbers is dropped", %{dir: dir} do
    write!(dir, "towns.json", ~s({"towns": [
      {"name": "Good", "bbox": [1, 2, 3, 4]},
      {"name": "TooShort", "bbox": [1, 2, 3]},
      {"name": "NotNumbers", "bbox": [1, 2, 3, "x"]},
      {"name": "NotAList", "bbox": "1,2,3,4"},
      {"bbox": [1, 2, 3, 4]}
    ]}))

    assert Enum.map(Towns.load(dir), & &1.name) == ["Good"]
  end

  test "an unreadable dir yields an empty list, never a crash", %{dir: dir} do
    assert Towns.load(Path.join(dir, "does-not-exist")) == []
    assert Towns.load(nil) == []
  end

  test "malformed JSON falls through to the .example template", %{dir: dir} do
    write!(dir, "towns.json", "{ not json")
    write!(dir, "towns.json.example", ~s({"towns": [{"name": "Fallback", "bbox": [1, 2, 3, 4]}]}))
    assert Enum.map(Towns.load(dir), & &1.name) == ["Fallback"]
  end

  test "a file with no towns key yields an empty list", %{dir: dir} do
    write!(dir, "towns.json", ~s({"_comment": "nothing here"}))
    assert Towns.load(dir) == []
  end

  test "a valid-but-empty towns.json does NOT fall through to .example", %{dir: dir} do
    write!(dir, "towns.json", ~s({"towns": []}))

    write!(
      dir,
      "towns.json.example",
      ~s({"towns": [{"name": "ShouldNotAppear", "bbox": [1, 2, 3, 4]}]})
    )

    assert Towns.load(dir) == []
  end
end
