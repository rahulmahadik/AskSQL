package com.rahulmahadik.asksql.ide.ui

import com.intellij.icons.AllIcons
import com.rahulmahadik.asksql.ide.engine.MongoExtract
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The controls around an answer: the copy affordance, and the collection line a pipeline needs to run. */
class TurnPanelControlsTest {

    /** No application here, so the clipboard service is unavailable. */
    @Test fun `a copy that fails shows a failure, not a check`() {
        val button = copyButton(null) { "SELECT 1" }
        button.doClick()
        assertEquals(COPY_FAILED_TOOLTIP, button.toolTipText)
        assertNotEquals("claimed success it never got", AllIcons.Actions.Checked, button.icon)
    }

    @Test fun `an icon-only copy button has an accessible name`() {
        assertEquals(COPY_TOOLTIP, copyButton(null) { "" }.accessibleContext.accessibleName)
    }

    @Test fun `a labelled copy button is named by its label`() {
        assertEquals("Copy", copyButton("Copy") { "" }.accessibleContext.accessibleName)
    }

    @Test fun `the pipeline clipboard text is a call mongosh can run`() {
        val pipeline = """[{"${'$'}match": {"status": "shipped"}}]"""
        val snippet = mongoShellSnippet("orders", pipeline)
        val extracted = MongoExtract.extractPipeline(snippet)
        assertNotNull("not a runnable aggregate call: $snippet", extracted)
        assertEquals("orders", extracted!!.collection)
        assertEquals(pipeline, extracted.pipelineJson)
    }

    /** Names that are not JS identifiers are exactly why the call uses getCollection(). */
    @Test fun `a dotted or hyphenated collection still round-trips`() {
        val extracted = MongoExtract.extractPipeline(mongoShellSnippet("order-items.2026", "[]"))
        assertNotNull(extracted)
        assertEquals("order-items.2026", extracted!!.collection)
    }

    @Test fun `the collection line is selectable, so it can be copied on its own`() {
        val field = selectableText("Collection: orders")
        assertFalse(field.isEditable)
        assertEquals("Collection: orders", field.text)
        assertTrue("a disabled field receives no mouse events, so its text cannot be selected", field.isEnabled)
        assertTrue("an unfocusable field cannot hold a caret, so its text cannot be selected", field.isFocusable)
    }
}
