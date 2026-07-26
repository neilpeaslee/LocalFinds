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

  defp thumb_for(%{rows: rows}, title), do: Enum.find(rows, &(&1.title == title)).thumb

  defp add_feedback(title, action) do
    Repo.query!(
      """
      INSERT INTO localfinds.feedback (find_id, action)
      SELECT id, $2 FROM localfinds.finds WHERE title = $1
      """,
      [title, action]
    )
  end

  # Inserts with an explicit created_at instead of the column's `now()`
  # default, so two calls can be given the *same* timestamp to force a
  # genuine tie between rows. Only `id` (insertion order) can break a tie
  # like that — a plain `add_feedback/2` pair never actually collides, since
  # separate statements land microseconds apart.
  defp add_feedback_at(title, action, created_at) do
    Repo.query!(
      """
      INSERT INTO localfinds.feedback (find_id, action, created_at)
      SELECT id, $2, $3 FROM localfinds.finds WHERE title = $1
      """,
      [title, action, created_at]
    )
  end

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

  describe "feed_page/1 thumb state" do
    test "the latest thumb wins when a find has both a thumbs_up and a later thumbs_down" do
      # Same created_at on both rows, on purpose: forces a genuine tie so this
      # only passes when "latest" means insertion order (id), not timestamp.
      # Two ordinary add_feedback/2 calls never actually tie — separate
      # statements land microseconds apart — so without this, the lateral
      # join's `order_by: [desc: fb.id]` could quietly regress to
      # `desc: fb.created_at` and the suite would never notice, only
      # production would, where two feedback rows can land in one
      # transaction with an identical timestamp.
      tie = DateTime.utc_now() |> DateTime.truncate(:second)
      add_feedback_at("Fresh news", "thumbs_up", tie)
      add_feedback_at("Fresh news", "thumbs_down", tie)

      assert thumb_for(Finds.feed_page(%{}), "Fresh news") == "thumbs_down"
    end

    test "a thumbs_clear at the same timestamp as an earlier thumbs_up wins by id, not created_at" do
      # Same tie-break rationale as above, for the retraction specifically: the
      # `with_thumb/1` CASE maps thumbs_clear to nil, but only AFTER the lateral
      # join has already picked "the latest thumb-ish row" by `id DESC`. If a
      # regression made that ordering fall back to `created_at` instead, this
      # tie would pass by luck on any other ordering and only fail here.
      tie = DateTime.utc_now() |> DateTime.truncate(:second)
      add_feedback_at("Fresh news", "thumbs_up", tie)
      add_feedback_at("Fresh news", "thumbs_clear", tie)

      assert thumb_for(Finds.feed_page(%{}), "Fresh news") == nil
    end

    # Pins the `action IN ('thumbs_up', 'thumbs_down')` filter on the lateral
    # join: without it, "the latest feedback row" is this find's star, and
    # thumb comes back "star" instead of nil.
    test "a find with only star/hide feedback has thumb: nil" do
      add_feedback("Old news", "hide")
      add_feedback("Old news", "star")

      assert thumb_for(Finds.feed_page(%{}), "Old news") == nil
    end

    test "a find with no feedback has thumb: nil" do
      assert thumb_for(Finds.feed_page(%{}), "Other source") == nil
    end

    test "thumbs_up then thumbs_clear renders as no thumb" do
      add_feedback("Old news", "thumbs_up")
      add_feedback("Old news", "thumbs_clear")

      assert thumb_for(Finds.feed_page(%{}), "Old news") == nil
    end

    test "thumbs_up, thumbs_clear, then thumbs_down renders as thumbs_down" do
      add_feedback("Old news", "thumbs_up")
      add_feedback("Old news", "thumbs_clear")
      add_feedback("Old news", "thumbs_down")

      assert thumb_for(Finds.feed_page(%{}), "Old news") == "thumbs_down"
    end

    test "a thumbs_clear with no prior thumb is harmless" do
      add_feedback("Old news", "thumbs_clear")

      assert thumb_for(Finds.feed_page(%{}), "Old news") == nil
    end
  end

  describe "feed_page/1 to boundary" do
    test "to includes a find in the final sub-second of the end day" do
      day = Date.add(Date.utc_today(), 5) |> Date.to_iso8601()

      # event_start lands in the last millisecond of `day`, in UTC — the same
      # instant the TS reference binds as `${to}T23:59:59.999Z`. `event_start` is
      # `:utc_datetime` (second precision), so a naive `<=` against that literal
      # gets truncated by Ecto's cast before it reaches Postgres and silently
      # excludes this row; the fix uses a strict `<` against the start of the
      # next day instead, which doesn't depend on sub-second precision at all.
      Repo.query!(
        """
        INSERT INTO localfinds.finds
          (title, url, url_hash, status, agent, source_id, discovered_at, event_start, tags, type)
        VALUES
          ('Last instant', 'https://alpha.test/9', 'h9', 'new', 'scout', 1, now(),
           ($1 || 'T23:59:59.999Z')::timestamptz, '{}', 'event')
        """,
        [day]
      )

      assert "Last instant" in titles(Finds.feed_page(%{view: "all", to: day}))
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
