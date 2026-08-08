package com.rahulmahadik.asksql.ide.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Models answer in Markdown; raw `**Explanation**:` must never reach the chat as literal asterisks. */
class TurnPanelMarkdownTest {

    private fun render(text: String) = markdownToHtml(text)

    @Test fun `a bold Explanation heading is dropped, not shown as asterisks`() {
        val out = render("**Explanation**: This counts the rows.")
        assertEquals("This counts the rows.", out)
    }

    @Test fun `bold spans become bold, not asterisks`() {
        assertEquals("Counts <b>every</b> row.", render("Counts **every** row."))
        assertEquals("Counts <b>every</b> row.", render("Counts __every__ row."))
    }

    @Test fun `inline code becomes code, not backticks`() {
        assertEquals("Filters on <code>status</code>.", render("Filters on `status`."))
    }

    @Test fun `bullet lists render as bullets`() {
        assertTrue(render("- one\n- two").contains("&bull; one"))
    }

    @Test fun `html in model output stays escaped`() {
        val out = render("Compares <script>alert(1)</script> values")
        assertTrue("raw HTML leaked: $out", !out.contains("<script>"))
        assertTrue(out.contains("&lt;script&gt;"))
    }

    @Test fun `plain text is unchanged apart from line breaks`() {
        assertEquals("Line one<br>Line two", render("Line one\nLine two"))
    }

    @Test fun `a fenced sql block becomes a code block, not literal backticks`() {
        val out = render("You could run:\n```sql\nALTER TABLE t ADD COLUMN x int;\n```\nRead-only.")
        assertTrue("expected a <pre> block, got: $out", out.contains("<pre>"))
        assertTrue("SQL missing from the block: $out", out.contains("ALTER TABLE t ADD COLUMN x int;"))
        assertTrue("fence markers leaked: $out", !out.contains("```"))
    }

    @Test fun `a multi-line fenced block keeps its line breaks inside the block`() {
        val out = render("```sql\nSELECT a,\n       b\nFROM t\n```")
        assertTrue(out.contains("SELECT a,<br>"))
        assertTrue(!out.contains("```"))
    }

    @Test fun `the question is right-aligned, opposite the assistant side`() {
        val out = questionHtml("show 10 rows from customers")
        assertEquals("<div align='right'><b>show 10 rows from customers</b></div>", out)
    }

    @Test fun `a question with html stays escaped`() {
        assertTrue(questionHtml("<b>hi</b>").contains("&lt;b&gt;hi&lt;/b&gt;"))
    }
}
