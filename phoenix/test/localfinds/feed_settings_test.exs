defmodule Localfinds.FeedSettingsTest do
  use ExUnit.Case, async: true

  alias Localfinds.FeedSettings

  describe "defaults/0" do
    test "matches the reference DEFAULT_SETTINGS" do
      assert FeedSettings.defaults() == %{
               view: "default",
               days: nil,
               from: nil,
               to: nil,
               page_size: 50,
               density: "full",
               sort: "newest"
             }
    end
  end

  describe "merge/2" do
    test "applies valid cookie fields and ignores unknown ones" do
      merged =
        FeedSettings.merge(FeedSettings.defaults(), %{
          "feed" => %{"pageSize" => 25, "density" => "compact", "junk" => "x"}
        })

      assert merged.page_size == 25
      assert merged.density == "compact"
      assert merged.view == "default"
    end

    test "falls back to defaults for tampered values" do
      merged =
        FeedSettings.merge(FeedSettings.defaults(), %{
          "feed" => %{"view" => "bogus", "pageSize" => "banana", "sort" => "sideways"}
        })

      assert merged == FeedSettings.defaults()
    end

    test "survives a non-map payload" do
      assert FeedSettings.merge(FeedSettings.defaults(), nil) == FeedSettings.defaults()
      assert FeedSettings.merge(FeedSettings.defaults(), "nope") == FeedSettings.defaults()
    end

    test "accepts the 'all' page size" do
      merged = FeedSettings.merge(FeedSettings.defaults(), %{"feed" => %{"pageSize" => "all"}})
      assert merged.page_size == :all
    end
  end

  describe "from_cookie/1 and to_cookie/1" do
    test "round-trips every field" do
      settings = %{
        view: "starred",
        days: nil,
        from: "2026-07-01",
        to: "2026-07-31",
        page_size: :all,
        density: "compact",
        sort: "soonest"
      }

      assert settings |> FeedSettings.to_cookie() |> FeedSettings.from_cookie() == settings
    end

    test "reads a cookie written by the Next app verbatim" do
      # encodeURIComponent(JSON.stringify({feed:{view:"starred",pageSize:25,
      #   density:"compact",sort:"oldest",days:7}})) — captured from the running app.
      raw =
        "%7B%22feed%22%3A%7B%22view%22%3A%22starred%22%2C%22pageSize%22%3A25%2C%22density%22%3A%22compact%22%2C%22sort%22%3A%22oldest%22%2C%22days%22%3A7%7D%7D"

      assert FeedSettings.from_cookie(raw) == %{
               view: "starred",
               days: 7,
               from: nil,
               to: nil,
               page_size: 25,
               density: "compact",
               sort: "oldest"
             }
    end

    test "omits absent optional fields from the encoded payload" do
      encoded = FeedSettings.to_cookie(FeedSettings.defaults())
      decoded = encoded |> URI.decode() |> Jason.decode!()

      assert decoded == %{
               "feed" => %{
                 "view" => "default",
                 "pageSize" => 50,
                 "density" => "full",
                 "sort" => "newest"
               }
             }
    end

    test "falls back to defaults for nil, junk and malformed percent-encoding" do
      assert FeedSettings.from_cookie(nil) == FeedSettings.defaults()
      assert FeedSettings.from_cookie("not json") == FeedSettings.defaults()
      assert FeedSettings.from_cookie("%") == FeedSettings.defaults()
      assert FeedSettings.from_cookie("%zz") == FeedSettings.defaults()
    end
  end

  describe "from_form/2" do
    test "keeps the current value when a field is missing or invalid" do
      current = %{FeedSettings.defaults() | view: "starred", sort: "oldest"}
      next = FeedSettings.from_form(%{"view" => "junk"}, current)

      assert next.view == "starred"
      assert next.sort == "oldest"
    end

    test "a submitted range clears the days window" do
      next =
        FeedSettings.from_form(
          %{"from" => "2026-07-01", "to" => "2026-07-31", "days" => "7"},
          FeedSettings.defaults()
        )

      assert next.from == "2026-07-01"
      assert next.to == "2026-07-31"
      assert next.days == nil
    end

    test "an empty range keeps the submitted days window" do
      next =
        FeedSettings.from_form(
          %{"from" => "", "to" => "", "days" => "30"},
          FeedSettings.defaults()
        )

      assert next.days == 30
      assert next.from == nil
    end

    test "clearing both date fields clears a persisted range" do
      current = %{FeedSettings.defaults() | from: "2026-01-01", to: "2026-01-31"}
      next = FeedSettings.from_form(%{"from" => "", "to" => "", "days" => ""}, current)

      assert next.from == nil
      assert next.to == nil
      assert next.days == nil
    end
  end

  describe "validators" do
    test "valid_page_size/1 returns nil for junk so callers fall through" do
      assert FeedSettings.valid_page_size("25") == 25
      assert FeedSettings.valid_page_size(100) == 100
      assert FeedSettings.valid_page_size("all") == :all
      assert FeedSettings.valid_page_size("banana") == nil
      assert FeedSettings.valid_page_size(7) == nil
    end

    test "valid_days/1 accepts only the three windows" do
      assert FeedSettings.valid_days("7") == 7
      assert FeedSettings.valid_days(30) == 30
      assert FeedSettings.valid_days("any") == nil
      assert FeedSettings.valid_days(3) == nil
    end

    test "valid_date/1 requires YYYY-MM-DD" do
      assert FeedSettings.valid_date("2026-07-25") == "2026-07-25"
      assert FeedSettings.valid_date("7/25/2026") == nil
      assert FeedSettings.valid_date(nil) == nil
    end
  end
end
