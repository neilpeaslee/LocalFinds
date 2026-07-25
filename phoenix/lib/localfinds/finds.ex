defmodule Localfinds.Finds do
  @moduledoc """
  Read queries over localfinds.finds. Port of the finds reads in
  packages/db/src/queries.ts; the feed page (a later plan) extends this context.
  """
  import Ecto.Query

  alias Localfinds.Finds.Find
  alias Localfinds.Repo

  @spec list_by_source(integer(), pos_integer()) :: [Find.t()]
  def list_by_source(source_id, limit \\ 10) do
    Repo.all(
      from f in Find,
        where: f.source_id == ^source_id,
        order_by: [desc: f.discovered_at],
        limit: ^limit
    )
  end
end
