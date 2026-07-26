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
end
