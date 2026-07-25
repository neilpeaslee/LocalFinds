defmodule Localfinds.DataDirTest do
  use ExUnit.Case, async: true

  alias Localfinds.DataDir

  setup do
    dir = Path.join(System.tmp_dir!(), "data_dir_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join([dir, "nested", "deeper"]))
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  test "find_from/1 walks up to the directory holding data/config", %{dir: dir} do
    File.mkdir_p!(Path.join([dir, "data", "config"]))
    assert DataDir.find_from(Path.join([dir, "nested", "deeper"])) == Path.join(dir, "data")
  end

  test "find_from/1 returns nil when no data/config exists above", %{dir: dir} do
    assert DataDir.find_from(Path.join([dir, "nested", "deeper"])) == nil
  end

  test "path/0 honours the :data_dir application env (what the test suite uses)" do
    assert DataDir.path() == Path.expand("../../test/fixtures/data", __DIR__)
  end

  test "config_file/1 and agent_workspace/1 build paths under the data dir" do
    root = DataDir.path()
    assert DataDir.config_file("region.md") == Path.join([root, "config", "region.md"])
    assert DataDir.agent_workspace("source-keeper") == Path.join([root, "agents", "source-keeper"])
  end
end
