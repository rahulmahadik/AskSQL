package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JEditorPane
import javax.swing.JPanel

internal fun escapeHtml(text: String): String =
    text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

/**
 * Models answer in Markdown, so raw `**bold**` and backticks would render as literal asterisks.
 * Escape first, then translate the few marks that actually show up in an explanation.
 */
private val FENCED_BLOCK_RE = Regex("""```[A-Za-z0-9]*\n?[\s\S]*?```""")

internal fun markdownToHtml(text: String): String = escapeHtml(text)
    // A leading "Explanation:" heading is redundant: this block already sits under the result.
    .replace(Regex("""^\s*(\*\*|__)?\s*Explanation\s*(\*\*|__)?\s*:\s*""", RegexOption.IGNORE_CASE), "")
    // Fenced blocks -> a <pre>; before inline `code`, and newlines become <br> here so the later \n->\<br> doesn't double.
    .replace(Regex("""```[A-Za-z0-9]*\n?([\s\S]*?)```""")) { m ->
        "<pre>${m.groupValues[1].trim('\n').replace("\n", "<br>")}</pre>"
    }
    .replace(Regex("""\*\*(.+?)\*\*""", RegexOption.DOT_MATCHES_ALL), "<b>$1</b>")
    .replace(Regex("""(?<!\w)__(.+?)__(?!\w)""", RegexOption.DOT_MATCHES_ALL), "<b>$1</b>")
    .replace(Regex("""`([^`]+)`"""), "<code>$1</code>")
    .replace(Regex("""(?m)^\s*[-*]\s+"""), "&bull; ")
    .replace("\n", "<br>")

/**
 * One question-answer turn in the transcript. All mutation methods must run on the EDT;
 * [ChatPanel]'s coroutine callbacks hop back via `invokeLater` before touching this class.
 */
class TurnPanel(private val project: Project, question: String) {

    val component = JBPanel<JBPanel<*>>().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        border = JBUI.Borders.empty(6, 8)
    }

    private val questionLabel = wrappingHtml("<b>${escapeHtml(question)}</b>")
    private val statusLabel = JBLabel(" ").apply { foreground = com.intellij.ui.JBColor.GRAY }
    /** Animated "working" indicator, visible only while [statusLabel] is non-blank. */
    private val statusIcon = com.intellij.util.ui.AsyncProcessIcon("askSqlTurnProgress").apply { isVisible = false }
    private val statusRow = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
        isOpaque = false
        border = null
        add(statusIcon)
        add(statusLabel)
    }
    /** Auto-generated explanation from `ask()`, shown by [showResult] after the result rather than before it. */
    private var pendingAskExplanation: String? = null

    /** BoxLayout, not BorderLayout: a turn appends across several separate calls (ask, execute, explain), and BorderLayout only keeps one component per region. */
    private val bodyPanel = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }

    var resultTablePanel: ResultTablePanel? = null
        private set

    init {
        // BoxLayout Y_AXIS aligns children by alignmentX; keep every row left-aligned so nothing indents.
        questionLabel.alignmentX = 0f
        statusRow.alignmentX = 0f
        bodyPanel.alignmentX = 0f
        component.add(roleHeader("You", com.intellij.icons.AllIcons.General.User))
        component.add(questionLabel)
        component.add(javax.swing.Box.createVerticalStrut(8))
        component.add(roleHeader("AskSQL", AskSqlIcons.ASSISTANT))
        component.add(statusRow)
        component.add(bodyPanel)
    }

    /** A small "You"/"AskSQL" row above each side of the turn, so who said what is obvious at a glance. */
    private fun roleHeader(name: String, icon: javax.swing.Icon): JPanel =
        JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
            isOpaque = false
            border = JBUI.Borders.emptyBottom(2)
            alignmentX = 0f
            add(JBLabel(icon))
            add(JBLabel(name).apply { font = font.deriveFont(java.awt.Font.BOLD); foreground = com.intellij.ui.JBColor.GRAY })
        }

    fun updateStatus(text: String) {
        statusLabel.text = text
        val busy = text.isNotBlank()
        statusIcon.isVisible = busy
        if (busy) statusIcon.resume() else statusIcon.suspend()
    }

    fun showSqlPendingApproval(sql: String, explanation: String? = null, onRun: () -> Unit, onCancel: () -> Unit) {
        bodyPanel.removeAll()
        val stack = JPanel()
        stack.layout = BoxLayout(stack, BoxLayout.Y_AXIS)
        stack.add(SqlBlockPanel(project, sql).component)
        explanation?.takeIf { it.isNotBlank() }?.let {
            stack.add(wrappingHtml("<i>${markdownToHtml(it)}</i>").apply { border = JBUI.Borders.empty(4, 2) })
            explanationShown = true
        }
        stack.add(ApprovalBar(onRun, onCancel).component)
        bodyPanel.add(stack)
        component.revalidate()
        component.repaint()
    }

    fun showSqlOnly(sql: String, explanation: String?) {
        bodyPanel.removeAll()
        bodyPanel.add(SqlBlockPanel(project, sql).component)
        // Stashed, not shown yet: showResult appends it AFTER the result table, so a turn reads question, query, result, explanation.
        pendingAskExplanation = explanation
        component.revalidate()
        component.repaint()
    }

    /** MongoDB counterpart to [showSqlPendingApproval]; the pipeline's target collection lives outside the JSON text, so it is shown as its own label above the block. */
    fun showMongoPipelinePendingApproval(collection: String, pipelineJson: String, explanation: String? = null, onRun: () -> Unit, onCancel: () -> Unit) {
        bodyPanel.removeAll()
        val stack = JPanel()
        stack.layout = BoxLayout(stack, BoxLayout.Y_AXIS)
        stack.add(JBLabel("Collection: $collection").apply { border = JBUI.Borders.empty(0, 2, 4, 2) })
        stack.add(SqlBlockPanel(project, pipelineJson, fileExtension = "json", languageId = "JSON").component)
        explanation?.takeIf { it.isNotBlank() }?.let {
            stack.add(wrappingHtml("<i>${markdownToHtml(it)}</i>").apply { border = JBUI.Borders.empty(4, 2) })
            explanationShown = true
        }
        stack.add(ApprovalBar(onRun, onCancel).component)
        bodyPanel.add(stack)
        component.revalidate()
        component.repaint()
    }

    /** MongoDB counterpart to [showSqlOnly]. */
    fun showMongoPipelineOnly(collection: String, pipelineJson: String, explanation: String?) {
        bodyPanel.removeAll()
        val stack = JPanel()
        stack.layout = BoxLayout(stack, BoxLayout.Y_AXIS)
        stack.add(JBLabel("Collection: $collection").apply { border = JBUI.Borders.empty(0, 2, 4, 2) })
        stack.add(SqlBlockPanel(project, pipelineJson, fileExtension = "json", languageId = "JSON").component)
        bodyPanel.add(stack)
        pendingAskExplanation = explanation
        component.revalidate()
        component.repaint()
    }

    private var explanationShown = false
    /** The single failure label currently shown for this turn, if any; see [showFailure]. */
    private var failureLabel: JEditorPane? = null

    fun showResult(
        resultSet: AskSqlResultSet,
        onExportCsv: (ResultTablePanel) -> Unit,
        onCopyResult: (ResultTablePanel) -> Unit,
        onOpenInEditor: (ResultTablePanel) -> Unit,
        onExplain: (() -> Unit)? = null,
    ) {
        clearFailure()
        val panel = ResultTablePanel(project, resultSet)
        resultTablePanel = panel
        val wrapper = JPanel(BorderLayout())
        wrapper.add(panel.component, BorderLayout.CENTER)

        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0))
        toolbar.add(JButton("Export CSV").apply { addActionListener { onExportCsv(panel) } })
        toolbar.add(JButton("Copy").apply { addActionListener { onCopyResult(panel) } })
        toolbar.add(JButton("Open in Editor").apply { addActionListener { onOpenInEditor(panel) } })
        // Table stays the default; the button only appears when [Charts.infer] finds something to draw.
        Charts.infer(resultSet)?.let { spec ->
            val chart = ResultChartPanel(spec).component
            var showingChart = false
            toolbar.add(
                JButton("Chart").apply {
                    addActionListener {
                        wrapper.remove(if (showingChart) chart else panel.component)
                        showingChart = !showingChart
                        wrapper.add(if (showingChart) chart else panel.component, BorderLayout.CENTER)
                        text = if (showingChart) "Table" else "Chart"
                        wrapper.revalidate()
                        wrapper.repaint()
                    }
                },
            )
        }
        if (onExplain != null) {
            val explainButton = JButton("Explain")
            explainButton.addActionListener { explainButton.isEnabled = false; onExplain() }
            toolbar.add(explainButton)
        }
        if (resultSet.warnings.isNotEmpty()) {
            toolbar.add(JBLabel(resultSet.warnings.joinToString(" · ")).apply { foreground = com.intellij.ui.JBColor.ORANGE })
        }

        wrapper.add(toolbar, BorderLayout.SOUTH)

        bodyPanel.add(wrapper)
        pendingAskExplanation?.let { explanation ->
            if (explanation.isNotBlank()) {
                bodyPanel.add(wrappingHtml("<i>${markdownToHtml(explanation)}</i>").apply { border = JBUI.Borders.empty(4, 2) })
                explanationShown = true
            }
            pendingAskExplanation = null
        }
        component.revalidate()
        component.repaint()
    }

    /** True once any description has been shown for this turn (inline prose or a dedicated Explain call); lets the caller skip a redundant auto-explain. */
    fun hasExplanation(): Boolean = explanationShown

    /** Appends the model's plain-language explanation below the result; called by the "Explain" button or the auto-explain path. */
    fun appendExplanation(text: String) {
        val label = wrappingHtml(markdownToHtml(text)).apply { border = JBUI.Borders.empty(6, 8) }
        explanationShown = true
        bodyPanel.add(label)
        component.revalidate()
        component.repaint()
    }

    fun showExplanationError(userMessage: String) {
        appendExplanation("Couldn't explain this query: $userMessage")
    }

    /** Renders a grounded plain-language schema answer (the answerSchemaQuestions fallback); no SQL, no results. */
    fun showSchemaAnswer(
        answer: String,
        unknownReferences: List<String>,
        isSchemaChange: Boolean,
        proposedSql: String? = null,
        /** A MongoDB answer proposes a pipeline, which is JSON rather than SQL. */
        proposedIsPipeline: Boolean = false,
    ) {
        updateStatus("")
        // A query in a prose answer is the same artifact as a generated one, so it gets the same
        // block and the same Copy button rather than being flattened into the text.
        val fence = if (proposedSql != null) FENCED_BLOCK_RE.find(answer) else null
        if (fence != null) {
            val before = answer.substring(0, fence.range.first).trimEnd()
            val after = answer.substring(fence.range.last + 1).trimStart()
            if (before.isNotBlank()) {
                bodyPanel.add(wrappingHtml(markdownToHtml(before)).apply { border = JBUI.Borders.empty(6, 8) })
            }
            bodyPanel.add(
                if (proposedIsPipeline) {
                    SqlBlockPanel(project, proposedSql!!, fileExtension = "json", languageId = "JSON").component
                } else {
                    SqlBlockPanel(project, proposedSql!!).component
                },
            )
            if (after.isNotBlank()) {
                bodyPanel.add(wrappingHtml(markdownToHtml(after)).apply { border = JBUI.Borders.empty(6, 8) })
            }
        } else {
            bodyPanel.add(wrappingHtml(markdownToHtml(answer)).apply { border = JBUI.Borders.empty(6, 8) })
        }
        if (unknownReferences.isNotEmpty()) {
            val names = escapeHtml(unknownReferences.joinToString(", "))
            val note = if (isSchemaChange) {
                "<i>Proposed names not in your current schema: $names. AskSQL is read-only and ran nothing.</i>"
            } else {
                "<i>Heads up: this mentioned names not in your schema ($names), so treat those with caution.</i>"
            }
            bodyPanel.add(wrappingHtml(note).apply { border = JBUI.Borders.empty(2, 8) })
        }
        bodyPanel.add(
            wrappingHtml("<i>Generated from your schema by the model - no query was run, so treat it as guidance.</i>")
                .apply { border = JBUI.Borders.empty(2, 8) },
        )
        component.revalidate()
        component.repaint()
    }

    fun showError(userMessage: String) {
        updateStatus("")
        showFailure(wrappingHtml(errorHtml(userMessage)))
    }

    /** A turn has at most one outcome: a new failure replaces the previous one, and a real result clears it. */
    private fun showFailure(label: JEditorPane) {
        failureLabel?.let { bodyPanel.remove(it) }
        failureLabel = label
        bodyPanel.add(label)
        component.revalidate()
        component.repaint()
    }

    private fun clearFailure() {
        failureLabel?.let { bodyPanel.remove(it) }
        failureLabel = null
    }

    /**
     * A "can't answer"/refusal is a normal outcome, not a failure, so it gets muted styling instead of
     * red [showError]. Pass leadIn = null when the message stands alone; [onOpenSettings] adds a switch-model hint.
     */
    fun showCannotAnswer(
        userMessage: String,
        leadIn: String? = "I wasn't able to build a query for that one:",
        onOpenSettings: (() -> Unit)? = null,
    ) {
        updateStatus("")
        val label = wrappingHtml(cannotAnswerHtml(userMessage, leadIn, onOpenSettings != null))
        if (onOpenSettings != null) {
            label.addHyperlinkListener { e ->
                if (e.eventType == javax.swing.event.HyperlinkEvent.EventType.ACTIVATED) onOpenSettings()
            }
        }
        showFailure(label)
        component.revalidate()
        component.repaint()
    }

    /** Replaces the rejected query with the corrected one; a turn shows a single statement. Approved like any other SQL. */
    fun showErrorWithSuggestedSqlFix(errorMessage: String, suggestedSql: String, onRunFix: () -> Unit, onDismiss: () -> Unit) {
        updateStatus("")
        replaceBodyWithSuggestion(
            errorMessage = errorMessage,
            heading = "Corrected to match your schema:",
            block = SqlBlockPanel(project, suggestedSql).component,
            onRunFix = onRunFix,
            onDismiss = onDismiss,
        )
    }

    /** Mongo counterpart to [showErrorWithSuggestedSqlFix]. */
    fun showErrorWithSuggestedMongoFix(errorMessage: String, collection: String, pipelineJson: String, onRunFix: () -> Unit, onDismiss: () -> Unit) {
        updateStatus("")
        replaceBodyWithSuggestion(
            errorMessage = errorMessage,
            heading = "Corrected to match your schema - collection: $collection",
            block = SqlBlockPanel(project, pipelineJson, fileExtension = "json", languageId = "JSON").component,
            onRunFix = onRunFix,
            onDismiss = onDismiss,
        )
    }

    private fun replaceBodyWithSuggestion(
        errorMessage: String,
        heading: String,
        block: JPanel,
        onRunFix: () -> Unit,
        onDismiss: () -> Unit,
    ) {
        bodyPanel.removeAll()
        failureLabel = null
        // Clears the rejected query's explanation; the caller auto-explains the corrected one.
        pendingAskExplanation = null
        explanationShown = false
        val stack = JPanel()
        stack.layout = BoxLayout(stack, BoxLayout.Y_AXIS)
        stack.add(wrappingHtml(errorHtml(errorMessage)).apply { border = JBUI.Borders.empty(2) })
        stack.add(JBLabel(heading).apply { border = JBUI.Borders.empty(6, 2, 2, 2) })
        stack.add(block)
        // Dismiss drops the stack; the caller re-shows the error.
        stack.add(ApprovalBar(onRunFix, { bodyPanel.remove(stack); onDismiss() }).component)
        bodyPanel.add(stack)
        component.revalidate()
        component.repaint()
    }


    /** A rich-text label that actually word-wraps, unlike [JBLabel] with HTML content. */
    private fun wrappingHtml(innerHtml: String): JEditorPane = JEditorPane("text/html", "<html><body>$innerHtml</body></html>").apply {
        isEditable = false
        isOpaque = false
        border = null
        putClientProperty(JEditorPane.HONOR_DISPLAY_PROPERTIES, true)
        font = com.intellij.util.ui.UIUtil.getLabelFont()
    }

    /** A theme-aware error color. */
    private fun errorHtml(message: String): String {
        val hex = com.intellij.ui.ColorUtil.toHex(com.intellij.util.ui.NamedColorUtil.getErrorForeground())
        return "<font color='#$hex'>${escapeHtml(message)}</font>"
    }

    /** Muted secondary-text color for the calm "can't answer" case; the message is LLM-sourced so it stays escaped. */
    private fun cannotAnswerHtml(message: String, leadIn: String?, withModelHint: Boolean): String {
        val hex = com.intellij.ui.ColorUtil.toHex(com.intellij.util.ui.UIUtil.getLabelForeground())
        val body = if (leadIn == null) escapeHtml(message) else "${escapeHtml(leadIn)}<br>${escapeHtml(message)}"
        val hint = if (withModelHint) {
            "<br><br>Try naming one table and what you want from it, for example \"show 10 rows from customers\". " +
                "If the question already looks answerable, a larger model may do better: <a href='settings'>change it in Settings</a>."
        } else {
            ""
        }
        return "<font color='#$hex'>$body$hint</font>"
    }
}
