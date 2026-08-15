package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.project.Project
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Font
import java.awt.Rectangle
import javax.swing.BoxLayout
import javax.swing.JPanel
import javax.swing.Scrollable
import javax.swing.ScrollPaneConstants
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

/** The scrolling turn list; whole turns older than [MAX_TURNS] are evicted to bound memory. */
class TranscriptView(project: Project, private val onSamplePick: (String) -> Unit) {

    companion object {
        private const val MAX_TURNS = 20

        /** Matches the VS Code extension's empty-state sample questions. */
        private val SAMPLE_QUESTIONS = listOf(
            "What tables are in this database?",
            "Show me 10 rows from one of the tables",
        )
    }

    val component = JPanel(BorderLayout())

    /** Tracks the viewport width so a wide child can't trigger a horizontal scrollbar. */
    private val turnsContainer = object : JPanel(), Scrollable {
        init { layout = BoxLayout(this, BoxLayout.Y_AXIS) }
        override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
        override fun getScrollableUnitIncrement(visibleRect: Rectangle, orientation: Int, direction: Int) = 16
        override fun getScrollableBlockIncrement(visibleRect: Rectangle, orientation: Int, direction: Int) = visibleRect.height
        override fun getScrollableTracksViewportWidth() = true
        override fun getScrollableTracksViewportHeight() = false
    }
    private val scrollPane = JBScrollPane(turnsContainer).apply {
        horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
    }
    private val turns = ArrayDeque<TurnPanel>()
    // Each turn's component and its trailing spacer live in ONE wrapper child, so evicting a turn removes both.
    private val wrappers = ArrayDeque<JPanel>()
    private val emptyStatePanel = buildEmptyStatePanel()

    init {
        component.add(emptyStatePanel, BorderLayout.CENTER)
    }

    private fun buildEmptyStatePanel(): JPanel {
        val inner = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(24)
        }
        inner.add(
            JBLabel("Ask your database in plain English.", SwingConstants.CENTER).apply {
                alignmentX = 0.5f
                font = font.deriveFont(Font.BOLD)
                border = JBUI.Borders.emptyBottom(4)
            },
        )
        inner.add(
            JBLabel("You see the SQL for every answer, and only read-only queries are allowed.", SwingConstants.CENTER).apply {
                alignmentX = 0.5f
                border = JBUI.Borders.emptyBottom(16)
            },
        )
        for (question in SAMPLE_QUESTIONS) {
            inner.add(ActionLink(question) { onSamplePick(question) }.apply { alignmentX = 0.5f })
            inner.add(javax.swing.Box.createVerticalStrut(4))
        }
        return JPanel(BorderLayout()).apply { add(inner, BorderLayout.CENTER) }
    }

    private fun showEmptyState() {
        component.removeAll()
        component.add(emptyStatePanel, BorderLayout.CENTER)
        component.revalidate()
        component.repaint()
    }

    private fun showTranscript() {
        component.removeAll()
        component.add(scrollPane, BorderLayout.CENTER)
        component.revalidate()
        component.repaint()
    }

    fun addTurn(turn: TurnPanel) {
        if (turns.isEmpty()) showTranscript()
        turns.addLast(turn)
        // Follow the answer only while already at the bottom.
        turn.onContentAppended = { if (isNearBottom()) scrollToBottom() }
        val wrapper = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            // The rule belongs to the turn above it, so it sits inside the strut.
            border = JBUI.Borders.compound(
                JBUI.Borders.emptyBottom(8),
                JBUI.Borders.customLine(com.intellij.ui.JBColor.border(), 0, 0, 1, 0),
            )
            add(turn.component)
            add(javax.swing.Box.createVerticalStrut(JBUI.scale(8)))
        }
        wrappers.addLast(wrapper)
        turnsContainer.add(wrapper)
        while (turns.size > MAX_TURNS) {
            turns.removeFirst()
            turnsContainer.remove(wrappers.removeFirst())
        }
        turnsContainer.revalidate()
        turnsContainer.repaint()
        scrollToBottom()
    }

    fun clear() {
        turns.clear()
        wrappers.clear()
        turnsContainer.removeAll()
        turnsContainer.revalidate()
        turnsContainer.repaint()
        showEmptyState()
    }

    /** Within one line of the end counts as "following along"; an exact test never matches mid-layout. */
    private fun isNearBottom(): Boolean {
        val bar = scrollPane.verticalScrollBar
        return bar.value + bar.visibleAmount >= bar.maximum - JBUI.scale(48)
    }

    private fun scrollToBottom() {
        SwingUtilities.invokeLater {
            val bar = scrollPane.verticalScrollBar
            bar.value = bar.maximum
        }
    }
}
