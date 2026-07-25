defmodule Localfinds.Finds.Find do
  @moduledoc """
  Read-only projection of localfinds.finds. The agents write this table through
  the TypeScript packages/db layer; the web only SELECTs, so there are no
  changesets.
  """
  use Ecto.Schema

  @primary_key {:id, :id, autogenerate: false}
  @schema_prefix "localfinds"
  schema "finds" do
    field :title, :string
    field :url, :string
    field :summary, :string
    field :event_start, :utc_datetime
    field :event_end, :utc_datetime
    field :expires_at, :utc_datetime
    field :score, :float
    field :discovered_at, :utc_datetime
    field :status, :string
    field :agent, :string
    field :source_id, :integer
    field :type, :string
    field :tags, {:array, :string}
    field :place_osm_id, :string
  end

  @type t :: %__MODULE__{}
end
