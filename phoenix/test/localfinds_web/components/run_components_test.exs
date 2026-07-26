defmodule LocalfindsWeb.RunComponentsTest do
  use ExUnit.Case, async: true
  import Phoenix.LiveViewTest

  alias Localfinds.Runs.Run
  alias Localfinds.Runs.RunEvent
  alias LocalfindsWeb.RunComponents

  defp event(kind, payload, seq \\ 0) do
    %RunEvent{
      run_id: 1,
      seq: seq,
      t: ~U[2026-07-26 12:00:00.000000Z],
      kind: kind,
      payload: payload
    }
  end

  describe "brief/1" do
    test "run_start names the model and turn cap" do
      b = RunComponents.brief(event("run_start", %{"model" => "opus", "maxTurns" => 30}))
      assert b.icon == "▶"
      assert b.text == "run started · opus · maxTurns 30"
      refute b.error
    end

    test "assistant_text collapses whitespace and truncates at 200 characters" do
      b = RunComponents.brief(event("assistant_text", %{"text" => "  a\n\n  b  "}))
      assert b.text == "a b"

      long = RunComponents.brief(event("assistant_text", %{"text" => String.duplicate("x", 250)}))
      assert String.length(long.text) == 200
    end

    test "tool_use renders the name and truncates the input JSON at 120 characters" do
      b =
        RunComponents.brief(
          event("tool_use", %{"name" => "WebFetch", "input" => %{"url" => "u"}})
        )

      assert b.text =~ "WebFetch"
      assert b.text =~ ~s("url")

      big =
        RunComponents.brief(
          event("tool_use", %{"name" => "T", "input" => %{"k" => String.duplicate("y", 300)}})
        )

      # "T " plus exactly 120 characters of JSON.
      assert String.length(big.text) == 122
    end

    test "tool_use with no input renders an empty object" do
      b = RunComponents.brief(event("tool_use", %{"name" => "T"}))
      assert b.text == "T {}"
    end

    test "tool_result flags errors" do
      assert %{text: "tool result", error: false} =
               RunComponents.brief(event("tool_result", %{"isError" => false}))

      assert %{text: "tool error", error: true} =
               RunComponents.brief(event("tool_result", %{"isError" => true}))
    end

    test "result renders subtype, turns and cost to four decimals" do
      b =
        RunComponents.brief(
          event("result", %{"subtype" => "success", "numTurns" => 12, "costUsd" => 0.12345})
        )

      assert b.icon == "✓"
      assert b.text == "success · 12 turns · $0.1235"
      refute b.error

      failed =
        RunComponents.brief(event("result", %{"subtype" => "error_max_turns", "numTurns" => 30}))

      assert failed.icon == "✕"
      assert failed.error
      assert failed.text =~ "$0.0000"
    end

    test "result tolerates a jsonb-decoded integer costUsd" do
      # Postgres/Jason round-trip a whole-number jsonb cost as an Elixir
      # integer, not a float — most plausibly 0 for a run that errored or
      # capped before spending anything. `float_to_binary/2` raises on a bare
      # integer, so this pins the coercion rather than a float literal like
      # the test above.
      zero =
        RunComponents.brief(
          event("result", %{"subtype" => "error_max_turns", "numTurns" => 30, "costUsd" => 0})
        )

      assert zero.text == "error_max_turns · 30 turns · $0.0000"

      whole =
        RunComponents.brief(
          event("result", %{"subtype" => "success", "numTurns" => 5, "costUsd" => 3})
        )

      assert whole.text == "success · 5 turns · $3.0000"
    end

    test "run_end reports the status and flags only errors" do
      assert %{icon: "■", text: "run success", error: false} =
               RunComponents.brief(event("run_end", %{"status" => "success"}))

      assert %{error: true} = RunComponents.brief(event("run_end", %{"status" => "error"}))
      assert %{error: false} = RunComponents.brief(event("run_end", %{"status" => "capped"}))
    end

    test "an unknown kind degrades instead of raising" do
      b = RunComponents.brief(event("something_new", %{"a" => 1}))
      assert b.icon
      assert is_binary(b.text)
    end
  end

  describe "duration/1" do
    test "renders whole seconds, or an em dash while unfinished" do
      assert RunComponents.duration(%Run{
               started_at: ~U[2026-07-26 12:00:00.000000Z],
               finished_at: ~U[2026-07-26 12:00:42.400000Z]
             }) == "42s"

      assert RunComponents.duration(%Run{
               started_at: ~U[2026-07-26 12:00:00.000000Z],
               finished_at: nil
             }) == "—"
    end
  end

  describe "transcript/1" do
    test "renders one row per event, with the full payload available" do
      html =
        render_component(&RunComponents.transcript/1,
          events: [{"event-0", event("run_start", %{"model" => "opus", "maxTurns" => 4}, 0)}],
          empty?: false,
          live?: false
        )

      assert html =~ "run started · opus · maxTurns 4"
      assert html =~ "maxTurns"
    end

    test "an empty transcript says so, differently while live" do
      live = render_component(&RunComponents.transcript/1, events: [], empty?: true, live?: true)
      assert live =~ "Waiting for the run to start…"

      done = render_component(&RunComponents.transcript/1, events: [], empty?: true, live?: false)
      assert done =~ "No transcript recorded for this run."
    end
  end
end
