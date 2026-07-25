defmodule LocalfindsWeb.FeedURLTest do
  use ExUnit.Case, async: true

  alias Localfinds.FeedSettings
  alias LocalfindsWeb.FeedURL

  defp defaults(patch \\ %{}), do: Map.merge(FeedSettings.defaults(), patch)

  defp state(patch \\ %{}) do
    %{
      view: "default",
      days: nil,
      from: nil,
      to: nil,
      tag: nil,
      type: nil,
      page_size: 50,
      density: "full",
      sort: "newest"
    }
    |> Map.merge(patch)
  end

  describe "href/3" do
    test "omits values equal to the cookie default" do
      assert FeedURL.href(state(), defaults()) == "/feed"
    end

    test "emits a value that differs from the cookie default (the 50-vs-25 bug)" do
      d = defaults(%{page_size: 25, sort: "soonest"})
      assert FeedURL.href(state(%{page_size: 50, sort: "soonest"}), d) == "/feed?size=50"
    end

    test "lets you pick the hardcoded-default sort when the cookie default differs" do
      assert FeedURL.href(state(%{sort: "newest"}), defaults(%{sort: "soonest"})) ==
               "/feed?sort=newest"
    end

    test "emits days=any to override a persisted date default, else stays clean" do
      assert FeedURL.href(state(), defaults(%{days: 7})) == "/feed?days=any"
      assert FeedURL.href(state(), defaults()) == "/feed"
    end

    test "handles windows and ranges against the default" do
      assert FeedURL.href(state(%{days: 7}), defaults()) == "/feed?days=7"
      assert FeedURL.href(state(%{days: 7}), defaults(%{days: 7})) == "/feed"

      assert FeedURL.href(state(%{from: "2026-07-01", to: "2026-07-31"}), defaults()) ==
               "/feed?from=2026-07-01&to=2026-07-31"
    end

    test "adds page only when > 1, and tags when present" do
      assert FeedURL.href(state(), defaults(), 1) == "/feed"
      assert FeedURL.href(state(), defaults(), 3) == "/feed?page=3"
      assert FeedURL.href(state(%{tag: "music"}), defaults()) == "/feed?tag=music"
    end

    test "emits type ad-hoc (never part of the cookie defaults)" do
      assert FeedURL.href(state(%{type: "lead"}), defaults()) == "/feed?type=lead"
      assert FeedURL.href(state(), defaults()) == "/feed"
    end

    test "encodes the all page size as size=all" do
      assert FeedURL.href(state(%{page_size: :all}), defaults()) == "/feed?size=all"
    end

    test "orders every param view, sort, density, size, dates, tag, type, page for side-by-side comparison with the Next page" do
      # Every field differs from its default (or is ad-hoc) so every param is
      # emitted; only the ORDER is under test here, not the presence.
      s =
        state(%{
          view: "starred",
          sort: "oldest",
          density: "compact",
          page_size: 25,
          days: 7,
          tag: "music",
          type: "lead"
        })

      d = defaults(%{view: "default", sort: "newest", density: "full", page_size: 50, days: nil})

      assert FeedURL.href(s, d, 3) ==
               "/feed?view=starred&sort=oldest&density=compact&size=25&days=7&tag=music&type=lead&page=3"
    end
  end

  describe "resolve/2 precedence (URL > cookie > default)" do
    test "returns hardcoded defaults for empty params and default settings" do
      r = FeedURL.resolve(%{}, FeedSettings.defaults())

      assert r.view == "default"
      assert r.page_size == 50
      assert r.density == "full"
      assert r.sort == "newest"
      assert r.page == 1
      assert r.days == nil
      assert r.from == nil
    end

    test "uses cookie defaults when no URL param is present" do
      d = defaults(%{page_size: 25, density: "compact", sort: "oldest"})
      r = FeedURL.resolve(%{}, d)

      assert r.page_size == 25
      assert r.density == "compact"
      assert r.sort == "oldest"
    end

    test "lets a URL param override the cookie default" do
      assert FeedURL.resolve(%{"size" => "100"}, defaults(%{page_size: 25})).page_size == 100
    end

    test "keeps page and type ad-hoc — never from the cookie" do
      assert FeedURL.resolve(%{"page" => "3"}, FeedSettings.defaults()).page == 3
      assert FeedURL.resolve(%{}, FeedSettings.defaults()).page == 1
      assert FeedURL.resolve(%{"type" => "lead"}, FeedSettings.defaults()).type == "lead"
      assert FeedURL.resolve(%{}, FeedSettings.defaults()).type == nil
    end

    test "URL range beats a URL days window" do
      r =
        FeedURL.resolve(
          %{"from" => "2026-02-01", "to" => "2026-02-05", "days" => "7"},
          FeedSettings.defaults()
        )

      assert r.from == "2026-02-01"
      assert r.to == "2026-02-05"
      assert r.days == nil
    end

    test "URL days beats a cookie range" do
      d = defaults(%{from: "2026-01-01", to: "2026-01-31"})
      r = FeedURL.resolve(%{"days" => "7"}, d)

      assert r.days == 7
      assert r.from == nil
    end

    test "treats days=any as an explicit no-date, overriding a cookie default" do
      r = FeedURL.resolve(%{"days" => "any"}, defaults(%{days: 7}))

      assert r.days == nil
      assert r.from == nil
    end

    test "falls through to the cookie range, then the cookie window" do
      ranged = FeedURL.resolve(%{}, defaults(%{from: "2026-03-01", to: "2026-03-10", days: 7}))
      assert ranged.from == "2026-03-01"
      assert ranged.days == nil

      windowed = FeedURL.resolve(%{}, defaults(%{days: 30}))
      assert windowed.days == 30
      assert windowed.from == nil
    end

    test "blank tag and type params read as absent" do
      r = FeedURL.resolve(%{"tag" => "", "type" => ""}, FeedSettings.defaults())
      assert r.tag == nil
      assert r.type == nil
    end
  end
end
