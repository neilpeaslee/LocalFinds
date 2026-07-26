defmodule LocalfindsWeb.FeedLive.WritesTest do
  use LocalfindsWeb.ConnCase, async: false
  use Localfinds.AuthCase
  import Localfinds.AuthCase
  import Phoenix.LiveViewTest

  alias Localfinds.Repo

  setup %{conn: conn} do
    Repo.query!("TRUNCATE localfinds.feedback, localfinds.finds RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.finds (id, title, url_hash, status, agent, discovered_at)
    OVERRIDING SYSTEM VALUE
    VALUES (1, 'First', 'g1', 'new', 'scout', now()),
           (2, 'Second', 'g2', 'shown', 'scout', now() - interval '1 hour'),
           (3, 'Buried', 'g3', 'hidden', 'scout', now() - interval '2 hours')
    """)

    {:ok,
     conn: conn,
     steward: create_user!("s@example.com", "correct horse battery", "steward"),
     member: create_user!("m@example.com", "correct horse battery", "member")}
  end

  defp status(id) do
    %{rows: [[status]]} = Repo.query!("SELECT status FROM localfinds.finds WHERE id = $1", [id])
    status
  end

  defp feedback_count do
    %{rows: [[n]]} = Repo.query!("SELECT count(*) FROM localfinds.feedback")
    n
  end

  describe "as a steward" do
    setup %{conn: conn, steward: steward}, do: %{conn: log_in_user(conn, steward)}

    test "starring a find records the signal and updates the row", %{conn: conn} do
      {:ok, lv, _html} = live(conn, ~p"/feed")

      html =
        lv
        |> element(~s{button[phx-value-id="1"][phx-value-action="star"]})
        |> render_click()

      assert status(1) == "starred"
      assert feedback_count() == 1
      # The list re-queried, so the button flipped to its starred state.
      assert html =~ "★ Starred"
    end

    test "a thumb records signal without changing the status", %{conn: conn} do
      {:ok, lv, _html} = live(conn, ~p"/feed")

      lv
      |> element(~s{button[phx-value-id="1"][phx-value-action="thumbs_up"]})
      |> render_click()

      assert status(1) == "new"
      assert feedback_count() == 1
    end

    test "hiding a find removes it from the default view", %{conn: conn} do
      {:ok, lv, _html} = live(conn, ~p"/feed")

      html =
        lv
        |> element(~s{button[phx-value-id="2"][phx-value-action="hide"]})
        |> render_click()

      assert status(2) == "hidden"
      refute html =~ "Second"
    end

    test "Star page applies to every visible find and records no feedback", %{conn: conn} do
      {:ok, lv, _html} = live(conn, ~p"/feed")
      lv |> element("button", "Star page") |> render_click()

      assert status(1) == "starred"
      assert status(2) == "starred"
      assert status(3) == "hidden"
      assert feedback_count() == 0
    end

    test "Unhide all restores hidden finds", %{conn: conn} do
      {:ok, lv, _html} = live(conn, ~p"/feed?view=hidden")
      html = lv |> element("button", "Unhide all") |> render_click()

      assert status(3) == "shown"
      refute html =~ "Buried"
    end

    test "the count line reflects the write", %{conn: conn} do
      {:ok, lv, html} = live(conn, ~p"/feed")
      assert html =~ "2 finds"

      html =
        lv
        |> element(~s{button[phx-value-id="1"][phx-value-action="hide"]})
        |> render_click()

      assert html =~ "1 find"
    end
  end

  describe "without a steward scope" do
    test "a pushed feedback event is refused for a logged-out visitor", %{conn: conn} do
      {:ok, lv, _html} = live(conn, ~p"/feed")

      # Bypass the UI entirely: the buttons are not rendered, so this is the only
      # way to prove the guard is the gate rather than the markup.
      html = render_click(lv, "feedback", %{"id" => "1", "action" => "star"})

      assert status(1) == "new"
      assert feedback_count() == 0
      assert html =~ "steward"
    end

    test "a pushed bulk event is refused for a member", %{conn: conn, member: member} do
      {:ok, lv, _html} = conn |> log_in_user(member) |> live(~p"/feed")

      render_click(lv, "bulk", %{"status" => "starred"})

      assert status(1) == "new"
      assert status(2) == "shown"
    end

    test "a pushed unhide_all event is refused", %{conn: conn} do
      {:ok, lv, _html} = live(conn, ~p"/feed")

      render_click(lv, "unhide_all", %{})

      assert status(3) == "hidden"
    end

    test "an unknown action from a steward is refused by the context", %{
      conn: conn,
      steward: steward
    } do
      {:ok, lv, _html} = conn |> log_in_user(steward) |> live(~p"/feed")

      render_click(lv, "feedback", %{"id" => "1", "action" => "delete_everything"})

      assert feedback_count() == 0
      assert status(1) == "new"
    end

    test "a non-numeric id is refused", %{conn: conn, steward: steward} do
      {:ok, lv, _html} = conn |> log_in_user(steward) |> live(~p"/feed")

      render_click(lv, "feedback", %{"id" => "1; DROP TABLE", "action" => "star"})

      assert feedback_count() == 0
    end
  end
end
