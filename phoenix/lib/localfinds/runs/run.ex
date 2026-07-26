defmodule Localfinds.Runs.Run do
  @moduledoc "Read-only projection of localfinds.runs. No changesets — the web role only SELECTs."
  use Ecto.Schema

  @primary_key {:id, :id, autogenerate: false}
  @schema_prefix "localfinds"
  schema "runs" do
    field :agent, :string
    # usec precision: started_at drives the 20-minute staleness comparison, and
    # :utc_datetime would silently truncate the column on the way in.
    field :started_at, :utc_datetime_usec
    field :finished_at, :utc_datetime_usec
    field :status, :string
    field :items_added, :integer
    field :items_updated, :integer
    field :warnings, :integer
    field :num_turns, :integer
    field :cost_usd, :float
    field :session_id, :string
    field :error, :string
  end
end
