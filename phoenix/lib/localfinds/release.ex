defmodule Localfinds.Release do
  @moduledoc """
  Console tasks for the running release: `bin/localfinds eval`.
  Registration is closed — these are the only account paths.
  """
  @app :localfinds

  def create_user(email, password, role \\ "member") do
    start_repo()

    case Localfinds.Accounts.create_user(email, password, role) do
      {:ok, user} -> IO.puts("created #{user.email} (#{user.role})")
      {:error, cs} -> IO.puts("error: #{inspect(cs.errors)}")
    end
  end

  def set_password(email, password) do
    start_repo()
    {:ok, _} = Localfinds.Accounts.set_password(email, password)
    IO.puts("password updated for #{email}")
  end

  defp start_repo do
    Application.load(@app)
    Enum.each([:crypto, :ssl, :postgrex, :ecto_sql], &Application.ensure_all_started/1)

    case Localfinds.Repo.start_link(pool_size: 2) do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> :ok
    end
  end
end
