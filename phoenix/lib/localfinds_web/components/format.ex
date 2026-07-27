defmodule LocalfindsWeb.Format do
  @moduledoc """
  Date formatting shared by the ported pages.

  Three formats, because the reference has three: table cells and metadata lines
  use a numeric `m/d/Y`, the feed's find cards use a full "Jul 5, 2026", and the
  dashboard's compact cards drop the year entirely.

  Zero-padding in `short_date/1` is deliberate: `Calendar.strftime` has no GNU
  `%-m` equivalent for a two-digit month, and padded is the safer parity choice.
  `medium_date/1` does use `%-d`, which Elixir supports, matching "Jul 5, 2026".

  All format the UTC value, matching the server-rendered reference.
  """

  @spec short_date(DateTime.t() | nil) :: String.t()
  def short_date(nil), do: "—"
  def short_date(%DateTime{} = dt), do: Calendar.strftime(dt, "%m/%d/%Y")

  @spec medium_date(DateTime.t() | nil) :: String.t() | nil
  def medium_date(nil), do: nil
  def medium_date(%DateTime{} = dt), do: Calendar.strftime(dt, "%b %-d, %Y")

  @doc """
  The dashboard find card's date: `toLocaleDateString(undefined, {month: "short",
  day: "numeric"})` — "Jul 27", with no year. Distinct from `medium_date/1`,
  which carries the year for the feed's fuller cards.
  """
  @spec short_month_day(DateTime.t() | nil) :: String.t() | nil
  def short_month_day(nil), do: nil
  def short_month_day(%DateTime{} = dt), do: Calendar.strftime(dt, "%b %-d")
end
