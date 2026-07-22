defmodule Localfinds.Accounts do
  @moduledoc """
  The Accounts context.

  The only account-creation paths are the hand-added `create_user/3` and
  `set_password/2`, called from `Localfinds.Release` (console-only). There
  is no self-service sign-up flow.
  """

  import Ecto.Query, warn: false
  alias Localfinds.Repo

  alias Localfinds.Accounts.{User, UserToken}

  ## Database getters

  @doc """
  Gets a user by email.

  ## Examples

      iex> get_user_by_email("foo@example.com")
      %User{}

      iex> get_user_by_email("unknown@example.com")
      nil

  """
  def get_user_by_email(email) when is_binary(email) do
    Repo.get_by(User, email: email)
  end

  @doc """
  Gets a user by email and password.

  ## Examples

      iex> get_user_by_email_and_password("foo@example.com", "correct_password")
      %User{}

      iex> get_user_by_email_and_password("foo@example.com", "invalid_password")
      nil

  """
  def get_user_by_email_and_password(email, password)
      when is_binary(email) and is_binary(password) do
    user = Repo.get_by(User, email: email)
    if User.valid_password?(user, password), do: user
  end

  @doc """
  Gets a single user.

  Raises `Ecto.NoResultsError` if the User does not exist.

  ## Examples

      iex> get_user!(123)
      %User{}

      iex> get_user!(456)
      ** (Ecto.NoResultsError)

  """
  def get_user!(id), do: Repo.get!(User, id)

  @doc "Console-only account creation. No registration surface exists."
  def create_user(email, password, role) when role in ["member", "steward"] do
    %User{}
    |> User.email_changeset(%{email: email})
    |> User.password_changeset(%{password: password})
    |> Ecto.Changeset.put_change(:role, role)
    |> Repo.insert()
  end

  @doc "Console-only password reset."
  def set_password(email, password) do
    Repo.get_by!(User, email: email)
    |> User.password_changeset(%{password: password})
    |> Repo.update()
  end

  ## Session

  @doc """
  Generates a session token.
  """
  def generate_user_session_token(user) do
    {token, user_token} = UserToken.build_session_token(user)
    Repo.insert!(user_token)
    token
  end

  @doc """
  Gets the user with the given signed token.

  If the token is valid `{user, token_inserted_at}` is returned, otherwise `nil` is returned.
  """
  def get_user_by_session_token(token) do
    {:ok, query} = UserToken.verify_session_token_query(token)
    Repo.one(query)
  end

  @doc """
  Deletes the signed token with the given context.
  """
  def delete_user_session_token(token) do
    Repo.delete_all(from(UserToken, where: [token: ^token, context: "session"]))
    :ok
  end
end
