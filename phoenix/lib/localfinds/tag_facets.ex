defmodule Localfinds.TagFacets do
  @moduledoc """
  Which OSM tags may be rendered as filter links on a place page.

  An **allowlist**, deliberately. Every tag used to be a link to
  `/places?tag=<key>=<value>`, which made each place's own `name`, `way_area`,
  `phone`, `email` and `website` a distinct crawlable URL — over 50,000 of them
  against a database of ~20,000 places, versus 935 distinct values across the
  categorical keys below. A denylist would default the next unfamiliar OSM key
  to linkable, which is exactly how `way_area` — a computed area attribute,
  unique per way — became a facet.

  Non-allowlisted tags are still *displayed*; they simply stop being links.
  """

  @linkable ~w(
    amenity shop cuisine tourism leisure craft office
    healthcare sport landuse historic emergency man_made
  )

  @doc """
  True when a `"key=value"` tag may be a filter link.

  Takes the whole tag string as produced by
  `Localfinds.Places.DirectoryPlace.tag_list/1`. The key is everything before
  the first `=`; a tag with no `=` is not a facet.
  """
  @spec linkable?(String.t()) :: boolean()
  def linkable?(tag) when is_binary(tag) do
    case String.split(tag, "=", parts: 2) do
      [key, _value] -> key in @linkable
      _ -> false
    end
  end

  def linkable?(_), do: false

  @doc "The allowlisted keys, for tests and documentation."
  @spec linkable_keys() :: [String.t()]
  def linkable_keys, do: @linkable
end
