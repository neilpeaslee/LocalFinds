defmodule Localfinds.Repo do
  use Ecto.Repo,
    otp_app: :localfinds,
    adapter: Ecto.Adapters.Postgres
end
