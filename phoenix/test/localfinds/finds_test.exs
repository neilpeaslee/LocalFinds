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
    INSERT INTO localfinds.finds
      (title, url, url_hash, status, agent, source_id, discovered_at,
       event_start, expires_at, tags, type)
    VALUES
      ('Old news', 'https://alpha.test/1', 'h1', 'shown', 'scout', 1,
       now() - interval '3 days', NULL, NULL, '{music}', 'event'),
      ('Fresh news', 'https://alpha.test/2', 'h2', 'new', 'scout', 1,
       now() - interval '1 hour', now() + interval '10 days', NULL, '{music,food}', 'event'),
      ('Other source', 'https://bravo.test/1', 'h3', 'new', 'scout', 2,
       now(), now() + interval '2 days', NULL, '{}', 'event'),
      ('Starred one', 'https://alpha.test/3', 'h4', 'starred', 'scout', 1,
       now() - interval '2 days', NULL, NULL, '{food}', 'event'),
      ('Hidden one', 'https://alpha.test/4', 'h5', 'hidden', 'scout', 1,
       now() - interval '2 days', NULL, NULL, '{}', 'event'),
      ('Provisional one', 'https://alpha.test/5', 'h6', 'provisional', 'prospector', 1,
       now() - interval '2 days', NULL, NULL, '{}', 'lead'),
      ('Expired one', 'https://alpha.test/6', 'h7', 'shown', 'scout', 1,
       now() - interval '2 days', NULL, now() - interval '1 day', '{}', 'event'),
      ('A lead', 'https://alpha.test/7', 'h8', 'new', 'prospector', 1,
       now() - interval '5 hours', NULL, NULL, '{food}', 'lead')
    """)

    :ok
  end

  defp titles(%{rows: rows}), do: Enum.map(rows, & &1.title)

  test "list_by_source/2 returns that source's finds, newest first" do
    titles = Enum.map(Finds.list_by_source(1), & &1.title)

    # Source 1 now carries every feed fixture but "Other source" (source 2).
    # Four of them share a discovered_at (inserted in the same statement), so
    # only the extremes are deterministic: "Fresh news" (-1h) leads, "Old news"
    # (-3d) trails.
    assert length(titles) == 7
    assert List.first(titles) == "Fresh news"
    assert List.last(titles) == "Old news"
  end

  test "list_by_source/2 honours the limit" do
    assert Enum.map(Finds.list_by_source(1, 1), & &1.title) == ["Fresh news"]
  end

  test "list_by_source/2 returns [] for a source with no finds" do
    assert Finds.list_by_source(999) == []
  end

  describe "feed_page/1 views" do
    test "the default view drops hidden, provisional and expired finds" do
      page = Finds.feed_page(%{})

      refute "Hidden one" in titles(page)
      refute "Provisional one" in titles(page)
      refute "Expired one" in titles(page)
      assert "Fresh news" in titles(page)
      assert page.total == 5
    end

    test "the starred view returns only starred finds" do
      assert titles(Finds.feed_page(%{view: "starred"})) == ["Starred one"]
    end

    test "the hidden view returns only hidden finds" do
      assert titles(Finds.feed_page(%{view: "hidden"})) == ["Hidden one"]
    end

    test "the all view includes everything, expired and provisional included" do
      page = Finds.feed_page(%{view: "all"})

      assert "Expired one" in titles(page)
      assert "Provisional one" in titles(page)
      assert page.total == 8
    end
  end

  describe "feed_page/1 filters" do
    test "days narrows by discovery time" do
      assert titles(Finds.feed_page(%{days: 1})) == ["Other source", "Fresh news", "A lead"]
    end

    test "tag matches an element of the tags array" do
      assert titles(Finds.feed_page(%{tag: "food"})) == ["Fresh news", "A lead", "Starred one"]
    end

    test "type filters on the find type" do
      assert titles(Finds.feed_page(%{type: "lead"})) == ["A lead"]
    end

    test "from and to bound the event start, inclusive of the whole end day" do
      today = Date.utc_today()
      in_three = Date.add(today, 3) |> Date.to_iso8601()
      in_twenty = Date.add(today, 20) |> Date.to_iso8601()

      # 'Other source' starts in 2 days, 'Fresh news' in 10.
      assert titles(Finds.feed_page(%{to: in_three})) == ["Other source"]
      assert titles(Finds.feed_page(%{from: in_three, to: in_twenty})) == ["Fresh news"]
    end
  end

  describe "feed_page/1 ordering and paging" do
    test "newest is the default order" do
      assert titles(Finds.feed_page(%{})) |> List.first() == "Other source"
    end

    test "oldest reverses it" do
      assert titles(Finds.feed_page(%{sort: "oldest"})) |> List.first() == "Old news"
    end

    test "soonest orders by event start and sinks undated finds" do
      titles = titles(Finds.feed_page(%{sort: "soonest"}))

      assert Enum.take(titles, 2) == ["Other source", "Fresh news"]
      assert List.last(titles) in ["Old news", "Starred one", "A lead"]
    end

    test "paging slices the ordered set and reports the total" do
      page = Finds.feed_page(%{page_size: 2, page: 2})

      assert length(page.rows) == 2
      assert page.total == 5
      assert page.page == 2
      assert page.page_count == 3
    end

    test "an out-of-range page clamps to the last page" do
      page = Finds.feed_page(%{page_size: 2, page: 99})
      assert page.page == 3
    end

    test "page_size :all returns everything on one page" do
      page = Finds.feed_page(%{page_size: :all})

      assert length(page.rows) == 5
      assert page.page_count == 1
    end
  end

  describe "list_active_tags/1 and list_find_types/0" do
    test "tags are ranked by frequency among feed-visible finds" do
      assert Finds.list_active_tags() == ["food", "music"]
    end

    test "the tag limit is honoured" do
      assert Finds.list_active_tags(1) == ["food"]
    end

    test "types are ranked by frequency among feed-visible finds" do
      assert Finds.list_find_types() == ["event", "lead"]
    end
  end
end
