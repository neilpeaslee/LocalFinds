defmodule Localfinds.Towns do
  @moduledoc """
  Covered towns from `data/config/towns.json` — port of `readTownsConfig()` in
  `packages/db/src/config.ts`.

  Feeds two things: the map's dashed fallback rectangles (for towns with no
  boundary polygon) and the dashboard's "towns covered" stat. A town survives
  only if its bbox is four finite numbers, matching `isValidTownBox` — a bad box
  is dropped rather than silently drawn somewhere wrong.

  `bbox` stays in the file's `[south, west, north, east]` order. Do not reorder
  it here: the hook and `Leaflet`'s `[[s, w], [n, e]]` rectangle bounds both
  expect that order, and PostGIS's w/s/e/n convention is a different layer's
  problem.
  """

  alias Localfinds.DataDir

  @type t :: %{name: String.t(), bbox: [number()], primary: boolean()}

  @spec load() :: [t()]
  def load, do: load(DataDir.path())

  @spec load(String.t() | nil) :: [t()]
  def load(nil), do: []

  def load(dir) do
    file = Path.join([dir, "config", "towns.json"])

    [file, file <> ".example"]
    |> Enum.find_value([], &read_towns/1)
  end

  defp read_towns(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, %{} = json} <- Jason.decode(raw) do
      # An accepted candidate with no usable towns still stops the search — the
      # TS reader returns {towns: []} rather than falling through, and a valid
      # file that lists nothing is a real answer, not a parse failure.
      json |> Map.get("towns") |> normalize()
    else
      _ -> nil
    end
  end

  defp normalize(towns) when is_list(towns) do
    for t <- towns, is_map(t), is_binary(t["name"]), valid_bbox?(t["bbox"]) do
      %{name: t["name"], bbox: t["bbox"], primary: t["primary"] == true}
    end
  end

  defp normalize(_), do: []

  defp valid_bbox?(bbox) when is_list(bbox) and length(bbox) == 4 do
    Enum.all?(bbox, &is_number/1)
  end

  defp valid_bbox?(_), do: false
end
