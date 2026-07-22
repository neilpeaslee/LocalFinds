defmodule Localfinds.SmokeTest do
  use ExUnit.Case, async: true

  test "osm_places fixture matview has the canonical 8 rows (7 OSM + 1 custom)" do
    %{rows: [[count]]} = Localfinds.Repo.query!("SELECT count(*) FROM public.osm_places")
    assert count == 8
  end

  test "exactly one custom row exists — the exclusion tests cannot pass vacuously" do
    %{rows: [[count]]} =
      Localfinds.Repo.query!(
        "SELECT count(*) FROM public.osm_places WHERE osm_id LIKE 'custom/%'"
      )

    assert count == 1
  end
end
