defmodule Localfinds.MarkdownTest do
  use ExUnit.Case, async: true

  alias Localfinds.Markdown

  defp html(md) do
    {:safe, out} = Markdown.to_html(md)
    IO.iodata_to_binary(out)
  end

  test "nil and blank input render nothing" do
    assert Markdown.to_html(nil) == nil
    assert Markdown.to_html("") == nil
    assert Markdown.to_html("   \n") == nil
  end

  test "renders the markdown the notes actually use" do
    out = html("## Hours\n\nOpen **daily**. See [the site](https://e.test).\n\n- one\n- two\n")
    assert out =~ "<h2>"
    assert out =~ "<strong>daily</strong>"
    assert out =~ ~s(<a href="https://e.test">the site</a>)
    assert out =~ "<li>"
  end

  test "renders GFM tables" do
    out = html("| a | b |\n|---|---|\n| 1 | 2 |\n")
    assert out =~ "<table>"
    assert out =~ "<td"
  end

  test "strips script tags and inline event handlers (react-markdown parity)" do
    out = html(~s[hi\n\n<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n])
    refute out =~ "<script"
    refute out =~ "onerror"
  end

  test "strips javascript: hrefs" do
    out = html("[click](javascript:alert(1))")
    refute out =~ "javascript:"
  end
end
