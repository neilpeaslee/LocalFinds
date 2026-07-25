defmodule LocalfindsWeb.Badges do
  @moduledoc """
  Tailwind class strings for the small status/tier badges shared by the ported
  pages.

  Two status vocabularies exist and are deliberately kept apart: a SOURCE is
  active/paused/dead, a PLACE is active/closed/unknown. They overlap only on
  "active". Merging them into one map would silently colour a place "dead".

  Unknown values return "" rather than raising — a badge is decoration, and a
  new status value in the database should not take a page down.
  """

  @source_status %{
    "active" => "bg-green-100 text-green-800",
    "paused" => "bg-stone-200 text-stone-600",
    "dead" => "bg-red-100 text-red-800"
  }

  @place_status %{
    "active" => "bg-green-100 text-green-800",
    "closed" => "bg-red-100 text-red-800",
    "unknown" => "bg-stone-200 text-stone-600"
  }

  @find_status %{
    "new" => "bg-blue-100 text-blue-800",
    "shown" => "bg-stone-100 text-stone-600",
    "hidden" => "bg-stone-200 text-stone-500",
    "starred" => "bg-amber-100 text-amber-800"
  }

  @tier %{
    1 => "bg-emerald-100 text-emerald-800",
    2 => "bg-sky-100 text-sky-800",
    3 => "bg-stone-100 text-stone-600",
    4 => "bg-stone-100 text-stone-400"
  }

  @spec source_status(String.t() | nil) :: String.t()
  def source_status(status), do: Map.get(@source_status, status, "")

  @spec place_status(String.t() | nil) :: String.t()
  def place_status(status), do: Map.get(@place_status, status, "")

  @spec find_status(String.t() | nil) :: String.t()
  def find_status(status), do: Map.get(@find_status, status, "")

  @spec tier(integer() | nil) :: String.t()
  def tier(tier), do: Map.get(@tier, tier, "")
end
