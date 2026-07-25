defmodule Localfinds.RegionTest do
  use ExUnit.Case, async: true

  alias Localfinds.Region

  setup do
    dir = Path.join(System.tmp_dir!(), "region_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(dir, "config"))
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  defp write!(dir, body), do: File.write!(Path.join([dir, "config", "region.md"]), body)

  test "reads the quoted frontmatter name (the real region.md shape)", %{dir: dir} do
    write!(dir, ~s(---\nname: "Rockland, Maine"\n---\n\n## Coverage\n))
    assert Region.name(dir) == "Rockland, Maine"
  end

  test "reads an unquoted frontmatter name", %{dir: dir} do
    write!(dir, "---\nname: Midcoast Maine\n---\n")
    assert Region.name(dir) == "Midcoast Maine"
  end

  test "falls back to \"Unnamed region\" for a readable file without frontmatter or a name key",
       %{dir: dir} do
    write!(dir, "# Just an H1\n")
    assert Region.name(dir) == "Unnamed region"

    write!(dir, "---\nother: value\n---\n")
    assert Region.name(dir) == "Unnamed region"
  end

  test "returns nil when the file does not exist", %{dir: dir} do
    refute File.exists?(Path.join([dir, "config", "region.md"]))
    assert Region.name(dir) == nil
  end

  test "name/1 with a nil dir returns nil" do
    assert Region.name(nil) == nil
  end

  test "name/0 resolves through the configured data dir" do
    assert Region.name() == "Testland, Maine"
  end
end
