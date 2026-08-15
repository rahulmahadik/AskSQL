package com.rahulmahadik.asksql.ide.ui

import javax.swing.JLabel
import javax.swing.plaf.basic.BasicHTML
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A Swing JLabel interprets its text as HTML the moment it starts with `<html>`, and Swing then
 * fetches `<img src="http://...">` while laying the document out. Table cells hold database values,
 * which are attacker-influenced, so the renderer must have HTML off.
 *
 * This pins the mechanism rather than the call site: BasicHTML is what decides, and `html.disable`
 * is what stops it.
 */
class SwingHtmlNeutralisedTest {

    private val hostile = "<html><img src=\"http://attacker.example/pixel\">"

    @Test
    fun `a plain JLabel really does build an HTML view for a hostile cell value`() {
        // Establishes that the threat is real before asserting the defence, so this test cannot
        // quietly pass because Swing stopped interpreting HTML.
        val label = JLabel()
        BasicHTML.updateRenderer(label, hostile)
        assertNotNull("Swing did not treat the value as HTML; the premise of this test is gone", label.getClientProperty(BasicHTML.propertyKey))
    }

    @Test
    fun `html_disable stops the renderer building an HTML view`() {
        val label = JLabel()
        label.putClientProperty("html.disable", true)
        BasicHTML.updateRenderer(label, hostile)
        assertNull("cell value was interpreted as HTML", label.getClientProperty(BasicHTML.propertyKey))
    }
}
