defmodule LocalfindsWeb.DegradedRenderTest do
  @moduledoc """
  Every ported page carries `<.db_unavailable :if={@db_unavailable} />` and
  guards its body with `:if={!@db_unavailable}`. Plan 2 shipped four such
  templates with none of them exercised end to end — the risky one being
  places_live/show, where `@place` is nil in that state and any unguarded
  reference to it would raise.
  """
  use ExUnit.Case, async: true
  import Phoenix.LiveViewTest

  defp degraded(module, assigns) do
    assigns
    |> Map.put(:db_unavailable, true)
    |> Map.put_new(:flash, %{})
    |> module.render()
    |> rendered_to_string()
  end

  test "sources index renders the degraded state" do
    html =
      degraded(LocalfindsWeb.SourcesLive.Index, %{
        rows: [],
        all: [],
        q: nil,
        status: nil,
        sort: nil,
        dir: :asc,
        state: %{q: nil, status: nil, sort: nil, dir: :asc}
      })

    assert html =~ "Temporarily unavailable"
  end

  test "sources show renders the degraded state with no source" do
    html =
      degraded(LocalfindsWeb.SourcesLive.Show, %{source: nil, note: nil, finds: []})

    assert html =~ "Temporarily unavailable"
  end

  test "places index renders the degraded state" do
    html =
      degraded(LocalfindsWeb.PlacesLive.Index, %{
        rows: [],
        towns: [],
        matched: 0,
        total: 0,
        page: 1,
        page_count: 1,
        start: 0,
        tier4_count: 0,
        chain_count: 0,
        has_filters: false,
        show_tier4: true,
        show_chains: true,
        town: nil,
        status: nil,
        tag: nil,
        q: nil,
        size: 50,
        sort: nil,
        dir: :asc,
        state: %{
          town: nil,
          status: nil,
          tag: nil,
          q: nil,
          tier4: nil,
          chains: nil,
          size: 50,
          sort: nil,
          dir: :asc
        }
      })

    assert html =~ "Temporarily unavailable"
  end

  test "places show renders the degraded state with a nil place" do
    html =
      degraded(LocalfindsWeb.PlacesLive.Show, %{place: nil, tier: nil, note: nil, tags: []})

    assert html =~ "Temporarily unavailable"
  end

  test "feed renders the degraded state" do
    html =
      degraded(LocalfindsWeb.FeedLive.Index, %{
        feed: %{rows: [], total: 0, page: 1, page_count: 1},
        resolved: LocalfindsWeb.FeedURL.resolve(%{}, Localfinds.FeedSettings.defaults()),
        defaults: Localfinds.FeedSettings.defaults(),
        tags: [],
        types: [],
        steward?: false
      })

    assert html =~ "Temporarily unavailable"
  end
end
