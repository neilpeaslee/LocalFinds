defmodule Localfinds.Markdown do
  @moduledoc """
  Markdown → sanitized HTML for the notes the detail pages render.

  Parity target: the Next pages use `react-markdown` + `remark-gfm`, which
  renders GFM and does NOT render raw HTML. Earmark passes raw HTML through
  (its `escape:` option does not stop `<script>`), so the sanitizer is
  load-bearing, not decoration: note text comes from the database and from agent
  workspaces, and an agent summarising a hostile page could emit markup.
  """

  @options %Earmark.Options{gfm: true, gfm_tables: true, compact_output: true}

  @spec to_html(String.t() | nil) :: Phoenix.HTML.safe() | nil
  def to_html(nil), do: nil

  def to_html(markdown) when is_binary(markdown) do
    if String.trim(markdown) == "" do
      nil
    else
      markdown
      |> Earmark.as_html!(@options)
      |> HtmlSanitizeEx.markdown_html()
      |> Phoenix.HTML.raw()
    end
  end
end
