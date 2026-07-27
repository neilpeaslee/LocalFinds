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

  # For the two pages whose "empty" assigns render an ordinary (non-degraded)
  # empty state that looks the same with or without the guard: render the
  # same assigns with db_unavailable: false first, so a refute on the
  # degraded render is proven non-vacuous rather than trivially true.
  defp healthy(module, assigns) do
    assigns
    |> Map.put(:db_unavailable, false)
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
    # `total: 0, has_filters: false` would suppress the whole body
    # (`:if={!@db_unavailable and (@total > 0 or @has_filters)}`) even when
    # healthy, so a guard-deletion test on those assigns can't tell degraded
    # from "no results" — either way nothing but the empty-state copy shows.
    # `has_filters: true` forces the body to *want* to render, so removing
    # the `!@db_unavailable` guard actually changes the output.
    assigns = %{
      rows: [],
      towns: [],
      matched: 0,
      total: 0,
      page: 1,
      page_count: 1,
      start: 0,
      tier4_count: 0,
      chain_count: 0,
      has_filters: true,
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
    }

    # Prove the search form is genuinely part of the body, not something that
    # shows up regardless — otherwise the refute below would be vacuous.
    assert healthy(LocalfindsWeb.PlacesLive.Index, assigns) =~ ~s(phx-submit="search")

    html = degraded(LocalfindsWeb.PlacesLive.Index, assigns)
    assert html =~ "Temporarily unavailable"
    refute html =~ ~s(phx-submit="search")
  end

  test "places show renders the degraded state with a nil place" do
    html =
      degraded(LocalfindsWeb.PlacesLive.Show, %{place: nil, tier: nil, note: nil, tags: []})

    assert html =~ "Temporarily unavailable"
  end

  test "feed renders the degraded state" do
    # The filter bar (which the "Any time" chip is part of) renders whenever
    # the body renders, regardless of row count — so an empty feed can't be
    # told apart from a degraded one by row count alone. Prove "Any time" is
    # genuinely body content first, then refute it in the degraded render.
    assigns = %{
      feed: %{rows: [], total: 0, page: 1, page_count: 1},
      resolved: LocalfindsWeb.FeedURL.resolve(%{}, Localfinds.FeedSettings.defaults()),
      defaults: Localfinds.FeedSettings.defaults(),
      tags: [],
      types: [],
      steward?: false
    }

    assert healthy(LocalfindsWeb.FeedLive.Index, assigns) =~ "Any time"

    html = degraded(LocalfindsWeb.FeedLive.Index, assigns)
    assert html =~ "Temporarily unavailable"
    refute html =~ "Any time"
  end

  test "agents index renders the degraded state" do
    assigns = %{
      runs: [],
      cost30: 0.0,
      now: ~U[2026-07-26 12:00:00.000000Z],
      in_progress?: false,
      active_run: nil,
      starting: nil,
      sections: [],
      current_scope: nil,
      empty?: true,
      last_seq: -1,
      streams: %{events: []}
    }

    # Non-vacuous: with the guard removed the healthy render still produces the
    # spend line, so the refute below is a real assertion.
    assert healthy(LocalfindsWeb.AgentsLive.Index, assigns) =~ "Agent spend, last 30 days"

    html = degraded(LocalfindsWeb.AgentsLive.Index, assigns)
    assert html =~ "Temporarily unavailable"
    refute html =~ "Agent spend, last 30 days"
  end

  test "agents run page renders the degraded state with no run" do
    assigns = %{
      run: nil,
      run_id: 1,
      now: ~U[2026-07-26 12:00:00.000000Z],
      warnings: 0,
      stale?: false,
      live?: false,
      empty?: true,
      last_seq: -1,
      streams: %{events: []}
    }

    html = degraded(LocalfindsWeb.AgentsLive.Run, assigns)
    assert html =~ "Temporarily unavailable"
  end

  test "home renders the degraded state" do
    # Both the stats section and the finds section are guarded by
    # :if={!@db_unavailable} — the stats section because @place_count and
    # @feed.total are DB-backed with zero fallbacks, and "0 places catalogued"
    # during a bounce would read as real data rather than unknown, same as
    # every sibling ported page. Prove "Current finds" and "places catalogued"
    # are genuinely guarded body content first — otherwise the refutes below
    # would pass for the wrong reason.
    assigns = %{
      region_name: "Testland, Maine",
      coverage: nil,
      towns: [],
      place_count: 0,
      feed: %{rows: [], total: 0, page: 1, page_count: 1},
      pins: [],
      boundaries: [],
      themes: [],
      map_ready?: false
    }

    healthy_html = healthy(LocalfindsWeb.HomeLive.Index, assigns)
    assert healthy_html =~ "places catalogued"
    assert healthy_html =~ "Current finds"

    html = degraded(LocalfindsWeb.HomeLive.Index, assigns)
    assert html =~ "Temporarily unavailable"
    refute html =~ "places catalogued"
    refute html =~ "Current finds"
    # The region heading does NOT survive a bounce: the whole stats section
    # (heading included) is guarded as one unit, matching /sources — a
    # partial page (banner + orphaned heading) is not the intended fallback.
    refute html =~ "Testland, Maine"
  end
end
