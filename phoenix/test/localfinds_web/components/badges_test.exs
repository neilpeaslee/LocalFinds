defmodule LocalfindsWeb.BadgesTest do
  use ExUnit.Case, async: true

  alias LocalfindsWeb.Badges
  alias LocalfindsWeb.Format

  test "source and place status vocabularies stay distinct" do
    assert Badges.source_status("dead") =~ "red"
    assert Badges.source_status("paused") =~ "stone"
    # "dead" is not a place status; it must not resolve to a source colour.
    assert Badges.place_status("dead") == ""
    assert Badges.place_status("closed") =~ "red"
  end

  test "unknown values render no classes rather than crashing" do
    assert Badges.source_status("nonsense") == ""
    assert Badges.find_status(nil) == ""
    assert Badges.tier(99) == ""
  end

  test "tier styles cover all four tiers" do
    for tier <- 1..4, do: refute(Badges.tier(tier) == "")
  end

  test "short_date/1 is zero-padded m/d/Y, em dash for nil" do
    assert Format.short_date(~U[2026-07-05 12:00:00Z]) == "07/05/2026"
    assert Format.short_date(nil) == "—"
  end

  test "medium_date/1 matches the card format, nil for nil" do
    assert Format.medium_date(~U[2026-07-05 12:00:00Z]) == "Jul 5, 2026"
    assert Format.medium_date(nil) == nil
  end
end
