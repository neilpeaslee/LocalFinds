defmodule LocalfindsWeb.Format do
  @moduledoc """
  Date formatting shared by the ported pages.

  Two formats, because the reference has two: table cells and metadata lines use
  a numeric `m/d/Y`, while find cards use the reference's
  `toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"})`.

  Zero-padding in `short_date/1` is deliberate: `Calendar.strftime` has no GNU
  `%-m` equivalent for a two-digit month, and padded is the safer parity choice.
  `medium_date/1` does use `%-d`, which Elixir supports, matching "Jul 5, 2026".

  Both format the UTC value, matching the server-rendered reference.
  """

  @spec short_date(DateTime.t() | nil) :: String.t()
  def short_date(nil), do: "—"
  def short_date(%DateTime{} = dt), do: Calendar.strftime(dt, "%m/%d/%Y")

  @spec medium_date(DateTime.t() | nil) :: String.t() | nil
  def medium_date(nil), do: nil
  def medium_date(%DateTime{} = dt), do: Calendar.strftime(dt, "%b %-d, %Y")
end
