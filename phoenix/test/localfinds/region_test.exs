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

  describe "coverage/1" do
    setup do
      dir = Path.join(System.tmp_dir!(), "region_cov_#{System.unique_integer([:positive])}")
      File.mkdir_p!(Path.join(dir, "config"))
      on_exit(fn -> File.rm_rf!(dir) end)
      {:ok, dir: dir}
    end

    defp write_region!(dir, body), do: File.write!(Path.join([dir, "config", "region.md"]), body)

    test "strips the frontmatter and cuts everything from ## Seed sources" do
      coverage = Localfinds.Region.coverage()
      assert coverage =~ "# Coverage"
      assert coverage =~ "centered on Rockland"
      refute coverage =~ "name:"
      refute coverage =~ "---"
      refute coverage =~ "Seed sources"
      refute coverage =~ "seed.test"
    end

    test "the result is trimmed at both ends" do
      coverage = Localfinds.Region.coverage()
      assert coverage == String.trim(coverage)
    end

    test "the Seed sources match is case-insensitive", %{dir: dir} do
      write_region!(dir, "---\nname: X\n---\n\nProse here.\n\n## SEED SOURCES\n\n- gone\n")
      assert Localfinds.Region.coverage(dir) == "Prose here."
    end

    test "a file with no Seed sources section keeps the whole body", %{dir: dir} do
      write_region!(dir, "---\nname: X\n---\n\nAll of it.\n")
      assert Localfinds.Region.coverage(dir) == "All of it."
    end

    test "a file with no frontmatter is returned as-is", %{dir: dir} do
      write_region!(dir, "Just prose.\n")
      assert Localfinds.Region.coverage(dir) == "Just prose."
    end

    test "'Seed sources' as body text, not a heading, does not truncate", %{dir: dir} do
      write_region!(dir, "---\nname: X\n---\n\nWe list Seed sources below.\n\nMore prose.\n")
      coverage = Localfinds.Region.coverage(dir)
      assert coverage =~ "We list Seed sources below."
      assert coverage =~ "More prose."
    end

    test "a missing file returns nil", %{dir: dir} do
      assert Localfinds.Region.coverage(Path.join(dir, "nope")) == nil
      assert Localfinds.Region.coverage(nil) == nil
    end

    test "a file whose prose is empty returns nil, so the caller needs one guard", %{dir: dir} do
      write_region!(dir, "---\nname: X\n---\n\n## Seed sources\n\n- only seeds\n")
      assert Localfinds.Region.coverage(dir) == nil
    end
  end
end
