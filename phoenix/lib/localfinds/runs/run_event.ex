defmodule Localfinds.Runs.RunEvent do
  @moduledoc """
  Read-only projection of localfinds.run_events.

  `payload` is jsonb written by the Node agent CLI, so its keys are camelCase
  strings — "numTurns", "costUsd", "toolUseId", "isError", "maxTurns". Anything
  reading it must match those, not Elixir snake_case.
  """
  use Ecto.Schema

  @primary_key false
  @schema_prefix "localfinds"
  schema "run_events" do
    field :run_id, :integer
    field :seq, :integer
    field :t, :utc_datetime_usec
    field :kind, :string
    field :payload, :map
  end
end
