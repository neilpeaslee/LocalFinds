defmodule LocalfindsWeb.HomeComponentsTest do
  use ExUnit.Case, async: true

  import Phoenix.LiveViewTest

  alias LocalfindsWeb.Format
  alias LocalfindsWeb.HomeComponents

  defp find(overrides \\ %{}) do
    Map.merge(
      %{
        id: 1,
        title: "Harbor Concert",
        url: "https://example.test/concert",
        summary: "An evening of music on the waterfront.",
        type: "event",
        event_start: ~U[2026-07-27 18:00:00Z],
        tags: ["music", "outdoors", "free"],
        agent: "scout"
      },
      overrides
    )
  end

  defp card(overrides \\ %{}) do
    render_component(&HomeComponents.compact_find_card/1, find: find(overrides))
  end

  describe "short_month_day/1" do
    test "formats as abbreviated month and un-padded day, with no year" do
      assert Format.short_month_day(~U[2026-07-27 18:00:00Z]) == "Jul 27"
      assert Format.short_month_day(~U[2026-01-05 00:00:00Z]) == "Jan 5"
    end

    test "is nil-safe, matching the reference's early return" do
      assert Format.short_month_day(nil) == nil
    end
  end

  describe "compact_find_card/1" do
    test "links the title when the find has a url, in a new tab" do
      html = card()
      assert html =~ "Harbor Concert"
      assert html =~ ~s(href="https://example.test/concert")
      assert html =~ ~s(target="_blank")
      assert html =~ ~s(rel="noopener noreferrer")
    end

    test "renders a bare title when the find has no url" do
      html = card(%{url: nil})
      assert html =~ "Harbor Concert"
      refute html =~ "href="
    end

    test "shows the summary clamped to two lines" do
      assert card() =~ "line-clamp-2"
      assert card() =~ "An evening of music on the waterfront."
    end

    test "omits the summary block entirely when there is none" do
      refute card(%{summary: nil}) =~ "line-clamp-2"
    end

    test "hides the type badge for events, shows it for everything else" do
      refute card() =~ "emerald"
      html = card(%{type: "deal"})
      assert html =~ "emerald"
      assert html =~ "deal"
    end

    test "shows the event date badge when there is a start date" do
      assert card() =~ "Jul 27"
      assert card() =~ "amber"
    end

    test "omits the date badge when there is no start date" do
      refute card(%{event_start: nil}) =~ "amber"
    end

    test "shows at most two tags — the dashboard trades detail for density" do
      html = card()
      assert html =~ "music"
      assert html =~ "outdoors"
      refute html =~ "free"
    end

    test "attributes the find to its agent" do
      assert card() =~ "via scout"
    end

    test "carries no action row — star/hide/thumbs live on /feed only" do
      html = card()
      refute html =~ "phx-click"
      refute html =~ "<button"
    end
  end

  describe "stat/1" do
    test "renders the value and its label" do
      html = render_component(&HomeComponents.stat/1, label: "towns covered", value: 4)
      assert html =~ "4"
      assert html =~ "towns covered"
    end

    test "renders a zero value rather than hiding it" do
      html = render_component(&HomeComponents.stat/1, label: "current finds", value: 0)
      assert html =~ "0"
    end
  end
end
