defmodule LocalfindsWeb.RunComponents do
  @moduledoc """
  Transcript rendering for the /agents pages — port of
  apps/web/src/components/RunTranscript.tsx.

  Every payload key matched here is camelCase, because run_events.payload is
  jsonb written by the Node agent CLI. Truncation lengths (200 for prose, 120
  for tool input) and the cost precisions are the reference's, verbatim.

  `transcript/1` takes a LiveView stream (an enumerable of `{dom_id, RunEvent}`
  tuples) rather than a plain list, even though the first caller (Task 4, the
  run-detail page) still passes a plain assign — Task 8 wires the live SSE feed
  through `phx-update="stream"`, and a list-shaped intermediate here would just
  get rewritten then.
  """
  use LocalfindsWeb, :html

  alias Localfinds.Runs.Run
  alias Localfinds.Runs.RunEvent

  @prose_limit 200
  @input_limit 120

  @spec brief(RunEvent.t()) :: %{icon: String.t(), text: String.t(), error: boolean()}
  def brief(%RunEvent{kind: "run_start", payload: p}) do
    %{
      icon: "▶",
      text: "run started · #{p["model"]} · maxTurns #{p["maxTurns"]}",
      error: false
    }
  end

  def brief(%RunEvent{kind: "assistant_text", payload: p}) do
    %{icon: "•", text: collapse(p["text"], @prose_limit), error: false}
  end

  def brief(%RunEvent{kind: "tool_use", payload: p}) do
    json = p |> Map.get("input", %{}) |> Jason.encode!() |> slice(@input_limit)
    %{icon: "→", text: "#{p["name"]} #{json}", error: false}
  end

  def brief(%RunEvent{kind: "tool_result", payload: p}) do
    error? = p["isError"] == true
    %{icon: "←", text: if(error?, do: "tool error", else: "tool result"), error: error?}
  end

  def brief(%RunEvent{kind: "result", payload: p}) do
    success? = p["subtype"] == "success"
    cost = :erlang.float_to_binary(p["costUsd"] || 0.0, decimals: 4)

    %{
      icon: if(success?, do: "✓", else: "✕"),
      text: "#{p["subtype"]} · #{p["numTurns"]} turns · $#{cost}",
      error: not success?
    }
  end

  def brief(%RunEvent{kind: "error", payload: p}) do
    %{icon: "✕", text: collapse(p["message"], @prose_limit), error: true}
  end

  def brief(%RunEvent{kind: "run_end", payload: p}) do
    %{icon: "■", text: "run #{p["status"]}", error: p["status"] == "error"}
  end

  # The event union grows on the CLI side (a JS discriminated union has no
  # runtime enforcement); an unrecognised kind should render a plain row
  # instead of crashing a live transcript mid-run.
  def brief(%RunEvent{kind: kind}) do
    %{icon: "·", text: kind, error: false}
  end

  @spec duration(Run.t()) :: String.t()
  def duration(%Run{finished_at: nil}), do: "—"

  def duration(%Run{started_at: started, finished_at: finished}) do
    seconds = DateTime.diff(finished, started, :millisecond) / 1000
    "#{round(seconds)}s"
  end

  # Same three-way split as the RunRow status colour in agents/page.tsx:66-73 —
  # success is green, running/capped (still-in-progress states) are amber,
  # everything else (including an unrecognised future status) is red.
  @spec status_class(String.t()) :: String.t()
  def status_class("success"), do: "text-green-700"
  def status_class(status) when status in ["running", "capped"], do: "text-amber-700"
  def status_class(_), do: "text-red-700"

  attr :id, :string, default: "transcript"
  attr :events, :any, required: true, doc: "a LiveView stream of {dom_id, RunEvent} tuples"
  attr :empty?, :boolean, required: true
  attr :live?, :boolean, default: false

  def transcript(assigns) do
    ~H"""
    <p :if={@empty?} class="text-xs text-stone-500">
      {if @live?, do: "Waiting for the run to start…", else: "No transcript recorded for this run."}
    </p>
    <div
      :if={!@empty?}
      id={@id}
      phx-update="stream"
      class="max-h-[28rem] overflow-y-auto rounded border border-stone-200 bg-white p-2 font-mono"
    >
      <.event_row :for={{dom_id, event} <- @events} id={dom_id} event={event} />
    </div>
    """
  end

  attr :id, :string, required: true
  attr :event, RunEvent, required: true

  def event_row(assigns) do
    assigns = assign(assigns, :brief, brief(assigns.event))

    ~H"""
    <details id={@id} class="border-t border-stone-100 py-1 text-xs">
      <summary class="cursor-pointer list-none">
        <span class="mr-2 inline-block w-4 text-stone-400">{@brief.icon}</span>
        <span class={if @brief.error, do: "text-red-700", else: "text-stone-700"}>
          {@brief.text}
        </span>
      </summary>
      <pre class="mt-1 overflow-x-auto rounded bg-stone-50 p-2 text-[11px] text-stone-600">{full(@event)}</pre>
    </details>
    """
  end

  # Mirrors rowToEvent in packages/db/src/run-events.ts: the payload's own
  # fields spread back out to the top level alongside kind/seq/t, so the raw
  # <pre> dump matches what JSON.stringify(ev, null, 2) showed in the
  # reference — not a {"kind": ..., "payload": {...}} envelope.
  defp full(%RunEvent{} = event) do
    event.payload
    |> Map.merge(%{"kind" => event.kind, "seq" => event.seq, "t" => event.t})
    |> Jason.encode!(pretty: true)
  end

  defp collapse(nil, _limit), do: ""

  defp collapse(text, limit) do
    text |> String.replace(~r/\s+/, " ") |> String.trim() |> slice(limit)
  end

  defp slice(string, limit), do: String.slice(string, 0, limit)
end
