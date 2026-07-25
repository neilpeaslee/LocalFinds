defmodule Localfinds.Sources do
  @moduledoc "Read queries over localfinds.sources."
  import Ecto.Query

  alias Localfinds.Repo
  alias Localfinds.Sources.Source

  @spec list_sources() :: [Source.t()]
  def list_sources do
    Repo.all(from s in Source, order_by: s.url)
  end

  @spec get_source(integer()) :: Source.t() | nil
  def get_source(id) when is_integer(id), do: Repo.get(Source, id)
end
