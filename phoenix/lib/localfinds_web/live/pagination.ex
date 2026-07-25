defmodule LocalfindsWeb.Pagination do
  @moduledoc """
  Page-size vocabulary and the numbered-pager sequence for the ported pages —
  port of `apps/web/src/lib/pagination.ts` (`PAGE_SIZES`, `pageWindow`). The
  window arithmetic itself now lives in `Localfinds.Pagination`, which this
  module delegates to, because query modules need it too.

  The ranked list is built and sorted in memory (tier comes from
  categories.json, not SQL), so paging is a slice of that sorted list. Payload
  size is what pagination limits here, not server work — revisiting that is a
  rebuild-era decision, not a port-era one.
  """

  @page_sizes [25, 50, 100, :all]
  @default_page_size 50

  @spec page_sizes() :: [25 | 50 | 100 | :all]
  def page_sizes, do: @page_sizes

  @spec default_page_size() :: 50
  def default_page_size, do: @default_page_size

  @spec parse_page_size(String.t() | nil) :: 25 | 50 | 100 | :all
  def parse_page_size("all"), do: :all

  def parse_page_size(raw) when is_binary(raw) do
    case Integer.parse(raw) do
      {n, ""} when n in [25, 50, 100] -> n
      _ -> @default_page_size
    end
  end

  def parse_page_size(_), do: @default_page_size

  @spec parse_page(String.t() | nil) :: pos_integer()
  def parse_page(raw) when is_binary(raw) do
    case Integer.parse(raw) do
      {n, _rest} when n >= 1 -> n
      _ -> 1
    end
  end

  def parse_page(_), do: 1

  @spec resolve_page(integer(), integer(), pos_integer()) :: %{
          page: pos_integer(),
          page_count: pos_integer(),
          start: integer(),
          end: integer()
        }
  defdelegate resolve_page(matched, page, size), to: Localfinds.Pagination

  @spec page_window(pos_integer(), pos_integer()) :: [pos_integer() | :ellipsis]
  def page_window(_page, page_count) when page_count <= 1, do: [1]

  def page_window(page, page_count) do
    [1, page_count, page - 1, page, page + 1]
    |> Enum.uniq()
    |> Enum.filter(&(&1 >= 1 and &1 <= page_count))
    |> Enum.sort()
    |> Enum.reduce({[], 0}, fn p, {out, prev} ->
      out =
        cond do
          # Exactly one page hidden — show it rather than a wasteful ellipsis.
          p - prev == 2 -> [prev + 1 | out]
          p - prev > 2 -> [:ellipsis | out]
          true -> out
        end

      {[p | out], p}
    end)
    |> elem(0)
    |> Enum.reverse()
  end
end
