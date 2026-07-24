defmodule LocalfindsWeb.SourceFilters do
  @moduledoc "Pure list logic for the /sources page — port of apps/web/src/lib/sources.ts."

  @statuses ["active", "paused", "dead"]
  def statuses, do: @statuses

  def parse_sort(raw) when raw in ["finds", "quality", "checked"], do: String.to_atom(raw)
  def parse_sort(_), do: :name

  def parse_dir("desc"), do: :desc
  def parse_dir(_), do: :asc

  def parse_status(raw) when raw in @statuses, do: raw
  def parse_status(_), do: nil

  def filter(sources, opts) do
    q = opts |> Map.get(:q) |> normalize_q()
    status = Map.get(opts, :status)

    Enum.filter(sources, fn s ->
      (is_nil(status) or s.status == status) and matches_q?(s, q)
    end)
  end

  defp normalize_q(nil), do: nil
  defp normalize_q(q), do: q |> String.trim() |> String.downcase() |> nil_if_empty()
  defp nil_if_empty(""), do: nil
  defp nil_if_empty(q), do: q

  defp matches_q?(_s, nil), do: true

  defp matches_q?(s, q) do
    in_name = s.name && String.contains?(String.downcase(s.name), q)
    in_url = String.contains?(String.downcase(s.url), q)
    in_name || in_url
  end

  def sort(sources, key, dir) do
    factor = if dir == :asc, do: 1, else: -1

    Enum.sort(sources, fn a, b ->
      av = value_of(a, key)
      bv = value_of(b, key)

      cond do
        av == bv -> true
        is_nil(av) -> false
        is_nil(bv) -> true
        lt?(av, bv) -> factor == 1
        true -> factor == -1
      end
    end)
  end

  # Elixir's generic `<` on DateTime structs compares struct fields in
  # alphabetical key order (day before month before year), which is NOT a
  # chronological comparison — e.g. 2026-01-05 < 2025-12-20 evaluates true.
  # Route DateTime pairs through DateTime.compare/2; everything else (names,
  # counts, quality floats) is fine with plain term ordering.
  defp lt?(%DateTime{} = a, %DateTime{} = b), do: DateTime.compare(a, b) == :lt
  defp lt?(a, b), do: a < b

  defp value_of(s, :name), do: String.downcase(s.name || s.url)
  defp value_of(s, :finds), do: s.finds_count
  defp value_of(s, :quality), do: s.quality_score
  defp value_of(s, :checked), do: s.last_checked_at

  def summarize(sources) do
    by_status = Map.new(@statuses, fn st -> {st, Enum.count(sources, &(&1.status == st))} end)
    total_finds = Enum.reduce(sources, 0, &(&1.finds_count + &2))
    qualities = for s <- sources, not is_nil(s.quality_score), do: s.quality_score

    avg_quality =
      case qualities do
        [] -> nil
        qs -> Enum.sum(qs) / length(qs)
      end

    %{
      total: length(sources),
      by_status: by_status,
      total_finds: total_finds,
      avg_quality: avg_quality
    }
  end
end
