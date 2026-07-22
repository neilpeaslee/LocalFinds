defmodule Localfinds.AuthCase do
  @moduledoc """
  Setup for tests that write auth tables. async: false in every user of this
  case — truncation on a shared DB races async tests by design.
  """
  use ExUnit.CaseTemplate

  setup do
    Localfinds.Repo.query!(
      "TRUNCATE localfinds.users_tokens, localfinds.users RESTART IDENTITY CASCADE"
    )

    :ok
  end

  def create_user!(email, password, role \\ "member") do
    {:ok, user} = Localfinds.Accounts.create_user(email, password, role)
    user
  end
end
