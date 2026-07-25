defmodule Localfinds.Pagination do
  @moduledoc """
  Page-window arithmetic — port of `resolvePage` in `packages/db/src/pagination.ts`.

  Lives in the data layer because query modules need it to turn a requested page
  into LIMIT/OFFSET. The view-side vocabulary (page sizes, the numbered-pager
  sequence) stays in `LocalfindsWeb.Pagination`, mirroring the same split in the
  reference codebase.
  """

  @spec resolve_page(integer(), integer(), pos_integer()) :: %{
          page: pos_integer(),
          page_count: pos_integer(),
          start: integer(),
          end: integer()
        }
  def resolve_page(matched, page, size) do
    size = max(1, size)
    page_count = max(1, ceil(matched / size))
    clamped = page |> max(1) |> min(page_count)
    start = (clamped - 1) * size

    %{page: clamped, page_count: page_count, start: start, end: min(start + size, matched)}
  end
end
