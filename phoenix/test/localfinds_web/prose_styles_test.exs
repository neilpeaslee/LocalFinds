defmodule LocalfindsWeb.ProseStylesTest do
  @moduledoc """
  The two detail pages render agent-written markdown inside
  `class="prose prose-sm prose-stone"`. Those class names came from the Next
  reference pages, but the CSS behind them lives in the Next app's
  `globals.css` — outside the page component — so the UI port copied the class
  names without the rules and the notes rendered as an undifferentiated block:
  Tailwind's preflight resets heading sizes, list markers and table borders,
  and nothing put them back.

  ExUnit cannot assert on rendered appearance, so this guards the next-best
  invariant: the stylesheet still defines a rule for every element the markdown
  pipeline can emit into a note. It fails loudly if the block is deleted, or if
  the renderer starts emitting an element nobody styled.
  """
  use ExUnit.Case, async: true

  alias Localfinds.Markdown

  @stylesheet Path.expand("../../assets/css/app.css", __DIR__)

  # Representative of a real source-keeper site note (see
  # data/agents/source-keeper/notes/sites/*.md): headings, prose, a GFM table,
  # bullets, emphasis, a link, inline code, a quote and a rule.
  @note """
  # camdenmaineexperience.com — Camden Maine Experience

  *First evaluated: 2026-06-21 (run 7)*

  ## What it is

  Visitor-oriented events aggregator with `ical` absent.

  | Page | URL |
  |---|---|
  | Events | https://e.test/events |

  - Food & drink
  - Arts & culture

  > Supplement primary sources rather than replace them.

  ---

  See [the calendar](https://e.test/events).
  """

  # thead/tbody/tr carry no visual weight of their own — th/td do.
  @structural ~w(thead tbody tr)

  test "the stylesheet defines a .prose rule for every element a note can emit" do
    css = File.read!(@stylesheet)

    emitted =
      @note
      |> Markdown.to_html()
      |> Phoenix.HTML.safe_to_string()
      |> then(&Regex.scan(~r/<([a-z][a-z0-9]*)[\s>]/, &1))
      |> Enum.map(fn [_, tag] -> tag end)
      |> Enum.uniq()
      |> Enum.reject(&(&1 in @structural))

    # Guard the guard: if the pipeline stops emitting rich markup, this test
    # would pass vacuously.
    assert "h2" in emitted and "table" in emitted and "ul" in emitted

    for tag <- emitted do
      assert css =~ ~r/\.prose[^{}]*\b#{tag}\b[^{}]*\{/,
             "no .prose rule for <#{tag}> in assets/css/app.css — " <>
               "a note using it renders unstyled (Tailwind preflight strips the default)"
    end
  end
end
