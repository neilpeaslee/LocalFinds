defmodule Localfinds.SourcesTest do
  use ExUnit.Case, async: false

  alias Localfinds.Sources
  alias Localfinds.Repo

  setup do
    Repo.query!("TRUNCATE localfinds.sources RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.sources (url, name, status, quality_score, finds_count, added_by)
    VALUES
      ('https://b.test', 'Beta', 'active', 4.0, 3, 'test'),
      ('https://a.test', 'Alpha', 'paused', NULL, 0, 'test')
    """)

    :ok
  end

  test "list_sources/0 returns all sources ordered by url" do
    assert Enum.map(Sources.list_sources(), & &1.url) == ["https://a.test", "https://b.test"]
  end

  test "list_sources/0 maps the columns the sources page reads" do
    beta = Enum.find(Sources.list_sources(), &(&1.name == "Beta"))
    assert beta.status == "active"
    assert beta.quality_score == 4.0
    assert beta.finds_count == 3
  end
end
