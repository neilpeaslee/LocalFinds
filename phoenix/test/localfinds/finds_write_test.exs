defmodule Localfinds.FindsWriteTest do
  use ExUnit.Case, async: false

  alias Localfinds.Finds
  alias Localfinds.Repo

  setup do
    Repo.query!("TRUNCATE localfinds.feedback, localfinds.finds RESTART IDENTITY CASCADE")

    Repo.query!("""
    INSERT INTO localfinds.finds (id, title, url_hash, status, agent)
    OVERRIDING SYSTEM VALUE
    VALUES (1, 'One', 'w1', 'new', 'scout'),
           (2, 'Two', 'w2', 'shown', 'scout'),
           (3, 'Three', 'w3', 'hidden', 'scout')
    """)

    :ok
  end

  defp status(id) do
    %{rows: [[status]]} =
      Repo.query!("SELECT status FROM localfinds.finds WHERE id = $1", [id])

    status
  end

  defp feedback_rows do
    %{rows: rows} =
      Repo.query!("SELECT find_id, action FROM localfinds.feedback ORDER BY id")

    rows
  end

  describe "record_feedback/2" do
    test "a thumb records the signal without touching the status" do
      assert {:ok, _} = Finds.record_feedback(1, "thumbs_up")

      assert feedback_rows() == [[1, "thumbs_up"]]
      assert status(1) == "new"
    end

    test "star and hide record the signal and move the status" do
      assert {:ok, _} = Finds.record_feedback(1, "star")
      assert status(1) == "starred"

      assert {:ok, _} = Finds.record_feedback(2, "hide")
      assert status(2) == "hidden"
    end

    test "unstar and unhide return the find to shown" do
      Finds.update_status(1, "starred")
      assert {:ok, _} = Finds.record_feedback(1, "unstar")
      assert status(1) == "shown"

      assert {:ok, _} = Finds.record_feedback(3, "unhide")
      assert status(3) == "shown"
    end

    test "an unknown action is refused and writes nothing" do
      assert {:error, :invalid_action} = Finds.record_feedback(1, "delete_everything")
      assert feedback_rows() == []
      assert status(1) == "new"
    end

    test "a feedback row for a missing find rolls the whole thing back" do
      assert {:error, _, _, _} = Finds.record_feedback(9999, "star")
      assert feedback_rows() == []
    end
  end

  describe "bulk status changes" do
    test "update_statuses/2 applies to every id and records no feedback" do
      assert Finds.update_statuses([1, 2], "starred") == 2

      assert status(1) == "starred"
      assert status(2) == "starred"
      assert feedback_rows() == []
    end

    test "update_statuses/2 with no ids is a no-op" do
      assert Finds.update_statuses([], "hidden") == 0
      assert status(1) == "new"
    end

    test "unhide_all/0 restores every hidden find" do
      assert Finds.unhide_all() == 1
      assert status(3) == "shown"
      assert status(1) == "new"
    end

    test "an unknown status is refused" do
      assert Finds.update_statuses([1], "bogus") == 0
      assert Finds.update_status(1, "bogus") == 0
      assert status(1) == "new"
    end
  end
end
