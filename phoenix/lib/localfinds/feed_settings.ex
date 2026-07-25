defmodule Localfinds.FeedSettings do
  @moduledoc """
  Cookie-backed feed defaults — port of `apps/web/src/lib/settings.ts`.

  A value resolves as URL param > cookie default > hardcoded default. This
  module owns the cookie half (shape, validation, the form merge);
  `LocalfindsWeb.FeedURL` owns the URL half, because that is where the param
  parsing and the page-size vocabulary live.

  The cookie is deliberately unchanged from the Next app: same name, unsigned,
  URL-encoded JSON with camelCase keys, so defaults saved before the cutover
  keep working — and keep working if the route is rolled back.

  Every field is validated on the way in and on the way out. The cookie is
  attacker-controlled input; a stale or hand-edited one must degrade to the
  defaults, never produce an invalid state.
  """

  @cookie "lf_settings"
  @views ~w(default starred hidden all)
  @densities ~w(full compact)
  @sorts ~w(newest oldest soonest)
  @sizes [25, 50, 100]
  @default_size 50
  @date_re ~r/^\d{4}-\d{2}-\d{2}$/

  @type page_size :: 25 | 50 | 100 | :all
  @type t :: %{
          view: String.t(),
          days: pos_integer() | nil,
          from: String.t() | nil,
          to: String.t() | nil,
          page_size: page_size(),
          density: String.t(),
          sort: String.t()
        }

  @spec cookie_name() :: String.t()
  def cookie_name, do: @cookie

  @spec defaults() :: t()
  def defaults do
    %{
      view: "default",
      days: nil,
      from: nil,
      to: nil,
      page_size: @default_size,
      density: "full",
      sort: "newest"
    }
  end

  # ---- Validators. Each returns the valid value or nil, so callers can fall
  # through to the next source in precedence with `||`. ----

  @spec valid_view(any()) :: String.t() | nil
  def valid_view(v) when is_binary(v), do: if(v in @views, do: v)
  def valid_view(_), do: nil

  @spec valid_density(any()) :: String.t() | nil
  def valid_density(v) when is_binary(v), do: if(v in @densities, do: v)
  def valid_density(_), do: nil

  @spec valid_sort(any()) :: String.t() | nil
  def valid_sort(v) when is_binary(v), do: if(v in @sorts, do: v)
  def valid_sort(_), do: nil

  @spec valid_date(any()) :: String.t() | nil
  def valid_date(v) when is_binary(v), do: if(Regex.match?(@date_re, v), do: v)
  def valid_date(_), do: nil

  @spec valid_days(any()) :: pos_integer() | nil
  def valid_days(v) do
    case to_int(v) do
      n when n in [1, 7, 30] -> n
      _ -> nil
    end
  end

  @spec valid_page_size(any()) :: page_size() | nil
  def valid_page_size("all"), do: :all
  def valid_page_size(:all), do: :all

  def valid_page_size(v) do
    case to_int(v) do
      n when n in @sizes -> n
      _ -> nil
    end
  end

  defp to_int(n) when is_integer(n), do: n

  defp to_int(b) when is_binary(b) do
    case Integer.parse(b) do
      {n, ""} -> n
      _ -> nil
    end
  end

  defp to_int(_), do: nil

  # ---- Cookie ----

  @doc "Decode + validate a raw cookie value. Total: any garbage yields defaults."
  @spec from_cookie(String.t() | nil) :: t()
  def from_cookie(nil), do: defaults()

  def from_cookie(raw) when is_binary(raw) do
    # URI.decode/1 is total — it never raises. A malformed escape (e.g. "%",
    # "%zz") passes through unchanged rather than raising ArgumentError, which
    # then fails Jason.decode as invalid JSON and falls through to defaults.
    case Jason.decode(URI.decode(raw)) do
      {:ok, decoded} -> merge(defaults(), decoded)
      _ -> defaults()
    end
  end

  def from_cookie(_), do: defaults()

  @doc "Encode settings the way the Next app does: encodeURIComponent(JSON.stringify(…))."
  @spec to_cookie(t()) :: String.t()
  def to_cookie(s) do
    feed =
      %{
        "view" => s.view,
        "pageSize" => size_to_json(s.page_size),
        "density" => s.density,
        "sort" => s.sort
      }
      |> put_present("days", s.days)
      |> put_present("from", s.from)
      |> put_present("to", s.to)

    %{"feed" => feed}
    |> Jason.encode!()
    |> URI.encode(&URI.char_unreserved?/1)
  end

  defp size_to_json(:all), do: "all"
  defp size_to_json(n), do: n

  defp put_present(map, _key, nil), do: map
  defp put_present(map, key, value), do: Map.put(map, key, value)

  @doc "Deep-merge a decoded cookie payload onto a base, validating every field."
  @spec merge(t(), any()) :: t()
  def merge(base, %{"feed" => feed}) when is_map(feed) do
    %{
      view: valid_view(feed["view"]) || base.view,
      days: valid_days(feed["days"]) || base.days,
      from: valid_date(feed["from"]) || base.from,
      to: valid_date(feed["to"]) || base.to,
      page_size: valid_page_size(feed["pageSize"]) || base.page_size,
      density: valid_density(feed["density"]) || base.density,
      sort: valid_sort(feed["sort"]) || base.sort
    }
  end

  def merge(base, _), do: base

  # ---- The settings form ----

  @doc """
  Build the next settings from a submitted form, port of `saveSettings`.

  Enum fields fall back to the *current* value when absent or invalid; the date
  fields do not, because clearing them is how a persisted range is removed. A
  submitted range beats a window, matching the panel's own help text.
  """
  @spec from_form(map(), t()) :: t()
  def from_form(params, current) do
    from = valid_date(params["from"])
    to = valid_date(params["to"])
    days = valid_days(params["days"])

    %{
      view: valid_view(params["view"]) || current.view,
      page_size: valid_page_size(params["pageSize"]) || current.page_size,
      density: valid_density(params["density"]) || current.density,
      sort: valid_sort(params["sort"]) || current.sort,
      from: from,
      to: to,
      days: if(from || to, do: nil, else: days)
    }
  end
end
