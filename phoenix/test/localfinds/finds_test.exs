defmodule Localfinds.FindsTest do
  use ExUnit.Case, async: false

  alias Localfinds.Finds
  alias Localfinds.Repo

  setup do
    Repo.query!("TRUNCATE localfinds.finds, localfinds.sources RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.sources (id, url, name, status, added_by)
    OVERRIDING SYSTEM VALUE
    VALUES (1, 'https://alpha.test', 'Alpha', 'active', 'test'),
           (2, 'https://bravo.test', 'Bravo', 'active', 'test')
    """)

    Repo.query!("""
    INSERT INTO localfinds.finds (title, url, url_hash, status, agent, source_id, discovered_at)
    VALUES
      ('Old news', 'https://alpha.test/1', 'h1', 'shown', 'scout', 1, now() - interval '3 days'),
      ('Fresh news', 'https://alpha.test/2', 'h2', 'new', 'scout', 1, now() - interval '1 hour'),
      ('Other source', 'https://bravo.test/1', 'h3', 'new', 'scout', 2, now())
    """)

    :ok
  end

  test "list_by_source/2 returns that source's finds, newest first" do
    assert Enum.map(Finds.list_by_source(1), & &1.title) == ["Fresh news", "Old news"]
  end

  test "list_by_source/2 honours the limit" do
    assert Enum.map(Finds.list_by_source(1, 1), & &1.title) == ["Fresh news"]
  end

  test "list_by_source/2 returns [] for a source with no finds" do
    assert Finds.list_by_source(999) == []
  end
end
