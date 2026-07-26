defmodule Localfinds.Finds.Find do
  @moduledoc """
  Read-shaped projection of localfinds.finds — still no changesets. The
  agents write this table through the TypeScript packages/db layer; the web's
  only writes are `status` transitions (feedback, bulk star/hide, unhide-all),
  issued as `update_all` in `Localfinds.Finds`, not through a changeset on
  this schema. That is deliberate: production grants the web role
  column-level `UPDATE (status)` on this table, so a changeset-based write —
  which sets every field in its change map — would touch other columns and
  fail live with `insufficient_privilege`, even though it works locally
  against the owning role.
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
    # Populated by Localfinds.Finds.feed_page/1's lateral join onto
    # localfinds.feedback — the find's most recent thumbs_up/thumbs_down, or
    # nil. Not a column on localfinds.finds itself.
    field :thumb, :string, virtual: true
  end

  @type t :: %__MODULE__{}
end
