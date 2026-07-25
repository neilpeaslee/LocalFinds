defmodule LocalfindsWeb.PaginationTest do
  use ExUnit.Case, async: true

  alias LocalfindsWeb.Pagination

  test "parse_page_size/1 accepts the four sizes and defaults to 50" do
    assert Pagination.parse_page_size("25") == 25
    assert Pagination.parse_page_size("100") == 100
    assert Pagination.parse_page_size("all") == :all
    assert Pagination.parse_page_size("77") == 50
    assert Pagination.parse_page_size(nil) == 50
    assert Pagination.parse_page_size("") == 50
  end

  test "parse_page/1 clamps to a positive integer" do
    assert Pagination.parse_page("3") == 3
    assert Pagination.parse_page("3abc") == 3
    assert Pagination.parse_page("0") == 1
    assert Pagination.parse_page("-2") == 1
    assert Pagination.parse_page("nope") == 1
    assert Pagination.parse_page(nil) == 1
  end

  test "resolve_page/3 windows a sorted list" do
    assert Pagination.resolve_page(120, 1, 50) == %{page: 1, page_count: 3, start: 0, end: 50}
    assert Pagination.resolve_page(120, 3, 50) == %{page: 3, page_count: 3, start: 100, end: 120}
  end

  test "resolve_page/3 clamps an out-of-range page" do
    assert Pagination.resolve_page(120, 99, 50) == %{page: 3, page_count: 3, start: 100, end: 120}
    assert Pagination.resolve_page(120, 0, 50) == %{page: 1, page_count: 3, start: 0, end: 50}
  end

  test "resolve_page/3 always yields at least one page" do
    assert Pagination.resolve_page(0, 1, 50) == %{page: 1, page_count: 1, start: 0, end: 0}
  end

  test "page_window/2 shows a single page as [1]" do
    assert Pagination.page_window(1, 1) == [1]
  end

  test "page_window/2 keeps first, last and the current neighbourhood" do
    assert Pagination.page_window(5, 10) == [1, :ellipsis, 4, 5, 6, :ellipsis, 10]
  end

  test "page_window/2 shows a single hidden page instead of an ellipsis" do
    assert Pagination.page_window(4, 10) == [1, 2, 3, 4, 5, :ellipsis, 10]
  end

  test "page_window/2 is contiguous when it fits" do
    assert Pagination.page_window(2, 4) == [1, 2, 3, 4]
  end
end
