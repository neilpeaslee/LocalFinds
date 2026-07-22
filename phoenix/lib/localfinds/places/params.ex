defmodule Localfinds.Places.Params do
  @moduledoc """
  Pure validation/normalization of `/osm/places` query params. Every 400 the
  contract defines originates here — no DB, no HTTP, no side effects.
  """

  @allowed_keys ~w(amenity shop tourism office craft leisure)
  @default_limit 200
  @max_limit 1000

  defstruct town: nil, bbox: nil, keys: nil, limit: @default_limit

  @type t :: %__MODULE__{
          town: String.t() | nil,
          bbox: {float(), float(), float(), float()} | nil,
          keys: [String.t()] | nil,
          limit: pos_integer()
        }

  @spec validate(map()) :: {:ok, t()} | {:error, String.t()}
  def validate(params) do
    with {:ok, p} <- area(params),
         {:ok, p} <- keys(p, params) do
      limit(p, params)
    end
  end

  defp area(%{"town" => _, "bbox" => _}),
    do: {:error, "provide exactly one of town or bbox"}

  defp area(%{"town" => town}) when is_binary(town) and town != "",
    do: {:ok, %__MODULE__{town: town}}

  defp area(%{"bbox" => bbox}) when is_binary(bbox) do
    with [s, w, n, e] <- parse_floats(bbox),
         true <- s < n and w < e,
         true <- s >= -90.0 and n <= 90.0 and w >= -180.0 and e <= 180.0 do
      {:ok, %__MODULE__{bbox: {s, w, n, e}}}
    else
      _ -> {:error, "malformed bbox: expected s,w,n,e (WGS84, s<n, w<e)"}
    end
  end

  defp area(_), do: {:error, "provide exactly one of town or bbox"}

  defp parse_floats(bbox) do
    parts = String.split(bbox, ",")

    with 4 <- length(parts),
         [{s, ""}, {w, ""}, {n, ""}, {e, ""}] <-
           Enum.map(parts, &Float.parse(String.trim(&1))) do
      [s, w, n, e]
    end
  end

  defp keys(p, %{"keys" => csv}) when is_binary(csv) do
    keys = csv |> String.split(",") |> Enum.map(&String.trim/1)

    case Enum.find(keys, &(&1 not in @allowed_keys)) do
      nil -> {:ok, %{p | keys: keys}}
      bad -> {:error, "unknown key: #{bad}"}
    end
  end

  defp keys(p, _), do: {:ok, p}

  defp limit(p, %{"limit" => raw}) when is_binary(raw) do
    case Integer.parse(raw) do
      {n, ""} when n >= 1 -> {:ok, %{p | limit: min(n, @max_limit)}}
      _ -> {:error, "invalid limit: must be an integer >= 1"}
    end
  end

  defp limit(p, _), do: {:ok, p}
end
