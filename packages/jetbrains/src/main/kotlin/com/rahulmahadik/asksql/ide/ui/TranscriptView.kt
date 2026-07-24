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

        /** Matches the VS Code extension's empty-state sample questions, so both clients start users off the same way. */
        private val SAMPLE_QUESTIONS = listOf(
            "What tables are in this database?",
            "Show me 10 rows from one of the tables",
        )
    }

    val component = JPanel(BorderLayout())

    /** Tracks the viewport width so a wide child can't trigger a horizontal scrollbar; only the result table's own scroll pane scrolls horizontally. */
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
    // Each turn's component and its trailing spacer are added to turnsContainer as ONE wrapper
    // (not two independent children), so evicting a turn removes both.
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
            JBLabel("The SQL is always shown before anything runs, and only read-only queries are allowed.", SwingConstants.CENTER).apply {
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
        val wrapper = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(turn.component)
            add(javax.swing.Box.createVerticalStrut(4))
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

    private fun scrollToBottom() {
        SwingUtilities.invokeLater {
            val bar = scrollPane.verticalScrollBar
            bar.value = bar.maximum
        }
    }
}
