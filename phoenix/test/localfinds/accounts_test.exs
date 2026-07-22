defmodule Localfinds.AccountsTest do
  use Localfinds.AuthCase, async: false
  import Localfinds.AuthCase

  alias Localfinds.Accounts
  alias Localfinds.Accounts.{User, UserToken}
  alias Localfinds.Repo

  describe "get_user_by_email/1" do
    test "does not return the user if the email does not exist" do
      refute Accounts.get_user_by_email("unknown@example.com")
    end

    test "returns the user if the email exists" do
      %{id: id} = user = create_user!("foo@example.com", "correct horse battery")
      assert %User{id: ^id} = Accounts.get_user_by_email(user.email)
    end
  end

  describe "get_user_by_email_and_password/2" do
    test "does not return the user if the email does not exist" do
      refute Accounts.get_user_by_email_and_password("unknown@example.com", "hello world!")
    end

    test "does not return the user if the password is not valid" do
      user = create_user!("foo@example.com", "correct horse battery")
      refute Accounts.get_user_by_email_and_password(user.email, "invalid")
    end

    test "returns the user if the email and password are valid" do
      %{id: id} = user = create_user!("foo@example.com", "correct horse battery")

      assert %User{id: ^id} =
               Accounts.get_user_by_email_and_password(user.email, "correct horse battery")
    end
  end

  describe "get_user!/1" do
    test "raises if id is invalid" do
      assert_raise Ecto.NoResultsError, fn ->
        Accounts.get_user!(-1)
      end
    end

    test "returns the user with the given id" do
      %{id: id} = user = create_user!("foo@example.com", "correct horse battery")
      assert %User{id: ^id} = Accounts.get_user!(user.id)
    end
  end

  describe "create_user/3" do
    test "stores role and hashes password" do
      {:ok, user} = Accounts.create_user("s@localfinds.me", "correct horse battery", "steward")
      assert user.role == "steward"
      refute user.hashed_password == "correct horse battery"
      assert Accounts.get_user_by_email_and_password("s@localfinds.me", "correct horse battery")
    end

    test "rejects an unknown role" do
      assert_raise FunctionClauseError, fn ->
        Accounts.create_user("s@localfinds.me", "correct horse battery", "admin")
      end
    end

    test "rejects a short password" do
      {:error, changeset} = Accounts.create_user("s@localfinds.me", "short", "member")

      assert %{password: ["should be at least 12 character(s)"]} =
               Localfinds.DataCase.errors_on(changeset)
    end

    test "rejects a duplicate email" do
      create_user!("dup@localfinds.me", "correct horse battery")

      {:error, changeset} =
        Accounts.create_user("dup@localfinds.me", "correct horse battery", "member")

      assert %{email: ["has already been taken"]} = Localfinds.DataCase.errors_on(changeset)
    end
  end

  describe "set_password/2" do
    test "rotates the password" do
      {:ok, _} = Accounts.create_user("s@localfinds.me", "old password 12", "member")
      {:ok, _} = Accounts.set_password("s@localfinds.me", "new password 12")
      refute Accounts.get_user_by_email_and_password("s@localfinds.me", "old password 12")
      assert Accounts.get_user_by_email_and_password("s@localfinds.me", "new password 12")
    end
  end

  describe "generate_user_session_token/1" do
    test "generates a token" do
      user = create_user!("foo@example.com", "correct horse battery")
      token = Accounts.generate_user_session_token(user)
      assert user_token = Repo.get_by(UserToken, token: token)
      assert user_token.context == "session"

      # Creating the same token for another user should fail
      other = create_user!("bar@example.com", "correct horse battery")

      assert_raise Ecto.ConstraintError, fn ->
        Repo.insert!(%UserToken{
          token: user_token.token,
          user_id: other.id,
          context: "session"
        })
      end
    end
  end

  describe "get_user_by_session_token/1" do
    test "returns user by token" do
      user = create_user!("foo@example.com", "correct horse battery")
      token = Accounts.generate_user_session_token(user)

      assert {session_user, token_inserted_at} = Accounts.get_user_by_session_token(token)
      assert session_user.id == user.id
      assert token_inserted_at != nil
    end

    test "does not return user for invalid token" do
      refute Accounts.get_user_by_session_token("oops")
    end

    test "does not return user for expired token" do
      user = create_user!("foo@example.com", "correct horse battery")
      token = Accounts.generate_user_session_token(user)
      dt = ~N[2020-01-01 00:00:00]
      {1, nil} = Repo.update_all(UserToken, set: [inserted_at: dt])
      refute Accounts.get_user_by_session_token(token)
    end
  end

  describe "delete_user_session_token/1" do
    test "deletes the token" do
      user = create_user!("foo@example.com", "correct horse battery")
      token = Accounts.generate_user_session_token(user)
      assert Accounts.delete_user_session_token(token) == :ok
      refute Accounts.get_user_by_session_token(token)
    end
  end

  describe "inspect/2 for the User module" do
    test "does not include password" do
      refute inspect(%User{password: "123456"}) =~ "password: \"123456\""
    end
  end
end
