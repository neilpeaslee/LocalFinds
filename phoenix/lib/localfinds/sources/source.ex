defmodule Localfinds.Sources.Source do
  @moduledoc "Read-only projection of localfinds.sources. No changesets — the web role only SELECTs."
  use Ecto.Schema

  @primary_key {:id, :id, autogenerate: false}
  @schema_prefix "localfinds"
  schema "sources" do
    field :url, :string
    field :name, :string
    field :notes_path, :string
    field :ical_url, :string
    field :status, :string
    field :quality_score, :float
    field :finds_count, :integer
    field :last_find_at, :utc_datetime
    field :last_checked_at, :utc_datetime
    field :added_by, :string
    field :created_at, :utc_datetime
  end
end
