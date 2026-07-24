package com.rahulmahadik.asksql.ide.ui

import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Font
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * First-run empty state, shown when there is no usable connection and/or no configured AI provider.
 * Every action here gets the user to a working chat without leaving the tool window.
 */
class OnboardingPanel(
    hasConnection: Boolean,
    hasProvider: Boolean,
    onAddConnection: () -> Unit,
    onTrySampleData: () -> Unit,
    onUseLocalModel: () -> Unit,
    onConfigureProvider: () -> Unit,
) {
    val component = JPanel(BorderLayout())

    init {
        val inner = JPanel()
        inner.layout = javax.swing.BoxLayout(inner, javax.swing.BoxLayout.Y_AXIS)
        inner.border = JBUI.Borders.empty(24)

        if (!hasConnection) {
            inner.add(heading("Step 1: connect a database"))
            inner.add(actionLink("→ Add a connection", onAddConnection))
            inner.add(actionLink("→ Try with sample data (no setup)", onTrySampleData))
            inner.add(javax.swing.Box.createVerticalStrut(20))
        }
        if (!hasProvider) {
            inner.add(heading("Step ${if (hasConnection) "1" else "2"}: choose an AI model"))
            inner.add(actionLink("→ Use a local model (Ollama or LM Studio, no API key)", onUseLocalModel))
            inner.add(actionLink("→ Configure a provider (OpenAI, Anthropic, Gemini, ...)", onConfigureProvider))
        }
        component.add(inner, BorderLayout.CENTER)
    }

    private fun heading(text: String) = JBLabel(text, SwingConstants.CENTER).apply {
        alignmentX = 0.5f
        font = font.deriveFont(Font.BOLD)
        border = JBUI.Borders.emptyBottom(6)
    }

    /** A real, theme-colored, underlined-on-hover link (not a borderless JButton, which rendered as plain, unclickable-looking text). */
    private fun actionLink(text: String, action: () -> Unit) = ActionLink(text) { action() }.apply {
        alignmentX = 0.5f
    }
}
