package com.rahulmahadik.asksql.ide.ui

import com.intellij.icons.AllIcons
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.accessibility.AccessibleAnnouncerUtil
import com.intellij.util.ui.accessibility.ScreenReader
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.datatransfer.StringSelection
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JEditorPane
import javax.swing.JPanel
import javax.swing.JTextField
import javax.swing.Timer
import javax.swing.text.View

internal fun escapeHtml(text: String): String =
    text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

// Hoisted: markdownToHtml runs on the EDT as each answer renders, and an
// inline Regex(...) recompiles its Pattern on every call.
private val EXPLANATION_HEADING_RE = Regex("""^\s*(\*\*|__)?\s*Explanation\s*(\*\*|__)?\s*:\s*""", RegexOption.IGNORE_CASE)
private val FENCED_CAPTURE_RE = Regex("""```[A-Za-z0-9]*\n?([\s\S]*?)```""")
private val BOLD_STARS_RE = Regex("""\*\*(.+?)\*\*""", RegexOption.DOT_MATCHES_ALL)
private val BOLD_UNDERSCORES_RE = Regex("""(?<!\w)__(.+?)__(?!\w)""", RegexOption.DOT_MATCHES_ALL)
private val INLINE_CODE_RE = Regex("""`([^`]+)`""")
private val BULLET_RE = Regex("""(?m)^\s*[-*]\s+""")

/** Models answer in Markdown. Escape first, then translate the few marks an explanation actually uses. */
internal fun markdownToHtml(text: String): String = escapeHtml(text)
    // A leading "Explanation:" heading is redundant: this block already sits under the result.
    .replace(EXPLANATION_HEADING_RE, "")
    // Fenced blocks -> a <pre>; before inline `code`, and newlines become <br> here so the later \n->\<br> doesn't double.
    .replace(FENCED_CAPTURE_RE) { m ->
        "<pre>${m.groupValues[1].trim('\n').replace("\n", "<br>")}</pre>"
    }
    .replace(BOLD_STARS_RE, "<b>$1</b>")
    .replace(BOLD_UNDERSCORES_RE, "<b>$1</b>")
    .replace(INLINE_CODE_RE, "<code>$1</code>")
    .replace(BULLET_RE, "&bull; ")
    .replace("\n", "<br>")

/**
 * Bubble tint for the question: an explicit light/dark pair, so it stays distinct from the
 * transcript background under any theme, including custom ones.
 */
internal val QUESTION_BUBBLE_BACKGROUND = com.intellij.ui.JBColor(java.awt.Color(0xE8F0FE), java.awt.Color(0x2E3641))
internal val QUESTION_BUBBLE_BORDER = com.intellij.ui.JBColor(java.awt.Color(0xCFDFF8), java.awt.Color(0x3C4657))

/** The question sits on the right of the turn, opposite the assistant. */
internal fun questionHtml(question: String): String = "<div align='right'><b>${escapeHtml(question)}</b></div>"

/** One run of a model answer: prose to render as HTML, or the body of a fenced block to render as code. */
internal sealed interface AnswerSegment {
    data class Prose(val text: String) : AnswerSegment
    data class Code(val code: String, val tag: String) : AnswerSegment
}

// Three or more: a model quoting fenced content emits a four-backtick fence.
private val FENCED_SEGMENT_RE = Regex("""`{3,}([A-Za-z0-9+#_-]*)[ \t]*\r?\n?([\s\S]*?)`{3,}""")

/** An unterminated fence stays prose, so a half-streamed answer never loses its text. */
internal fun splitFencedSegments(answer: String): List<AnswerSegment> {
    val segments = mutableListOf<AnswerSegment>()
    var cursor = 0
    for (m in FENCED_SEGMENT_RE.findAll(answer)) {
        answer.substring(cursor, m.range.first).takeIf { it.isNotBlank() }?.let { segments += AnswerSegment.Prose(it) }
        m.groupValues[2].trim('\n', '\r').takeIf { it.isNotBlank() }?.let { segments += AnswerSegment.Code(it, m.groupValues[1].lowercase()) }
        cursor = m.range.last + 1
    }
    answer.substring(cursor).takeIf { it.isNotBlank() }?.let { segments += AnswerSegment.Prose(it) }
    return segments
}

private val SQL_FENCE_TAGS = setOf("sql", "postgres", "postgresql", "psql", "mysql", "mariadb", "sqlite", "tsql", "plsql", "oracle")

/** Fence tag to the file type [SqlBlockPanel] highlights with; an unknown tag stays plain text. */
internal fun fenceLanguage(tag: String, defaultIsJson: Boolean): Pair<String, String> = when {
    tag == "json" || (tag.isEmpty() && defaultIsJson) -> "json" to "JSON"
    tag in SQL_FENCE_TAGS || tag.isEmpty() -> "sql" to "SQL"
    else -> "txt" to "TEXT"
}

/** Each block is a real editor on the EDT, so a runaway reply renders the rest as plain text instead. */
internal const val MAX_INLINE_CODE_BLOCKS = 5

/** The `mongosh` call MongoExtract accepts; the collection is outside the JSON. */
internal fun mongoShellSnippet(collection: String, pipelineJson: String): String {
    val quoted = collection.replace("\\", "\\\\").replace("\"", "\\\"")
    return "db.getCollection(\"$quoted\").aggregate($pipelineJson)"
}

/** Selectable one-line text that reads as a label; a [JBLabel]'s content cannot be copied out. */
/** Null when there is nothing to warn about, so a caller adds it only when non-null. */
internal fun warningsLabel(warnings: List<String>): JBLabel? =
    if (warnings.isEmpty()) null else JBLabel(warnings.joinToString(" · ")).apply { foreground = com.intellij.ui.JBColor.ORANGE }

internal fun selectableText(text: String): JTextField =
    object : JTextField(text) {
        // Otherwise the column hands this field any leftover vertical space.
        override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
    }.apply {
        isEditable = false
        isOpaque = false
        border = JBUI.Borders.empty(0, 2, 4, 2)
        alignmentX = 0f
        font = com.intellij.util.ui.UIUtil.getLabelFont()
        foreground = com.intellij.util.ui.UIUtil.getLabelForeground()
    }

private const val EXPLAIN_BUSY_TEXT = "Describing…"
private const val EXPLAIN_DONE_TOOLTIP = "Already described below"

/** IDLE offers a description, BUSY is one in flight, DONE means the turn already has one. */
internal enum class ExplainState { IDLE, BUSY, DONE }

/** Describing again returns the same text, so only a failure leaves the button offered. */
internal fun explainStateAfter(stillInFlight: Int, succeeded: Boolean): ExplainState = when {
    stillInFlight > 0 -> ExplainState.BUSY
    succeeded -> ExplainState.DONE
    else -> ExplainState.IDLE
}

/** The sentence the engine appends to a proposed write. */
internal const val READ_ONLY_LINE_MARKER = "AskSQL is read-only"

/** How long a copy button shows its outcome icon before it reverts to the copy icon. */
private const val COPY_FEEDBACK_MS = 1200

internal const val COPY_TOOLTIP = "Copy to clipboard"
internal const val COPY_FAILED_TOOLTIP = "Copy failed"

/**
 * Copy control for one answer: [source] is read on click, so the clipboard gets the model's raw
 * text, not the rendered HTML. A null [label] gives the borderless icon-only form.
 */
internal fun copyButton(label: String?, source: () -> String): JButton =
    JButton(label, AllIcons.Actions.Copy).apply {
        toolTipText = COPY_TOOLTIP
        isFocusPainted = false
        // The icon-only form has no text, so a screen reader has nothing else to read.
        accessibleContext.accessibleName = label ?: COPY_TOOLTIP
        if (label == null) {
            isContentAreaFilled = false
            isBorderPainted = false
            isOpaque = false
            border = JBUI.Borders.empty(2)
            cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        }
        addActionListener {
            val copied = runCatching {
                CopyPasteManager.getInstance().setContents(StringSelection(source()))
            }.isSuccess
            icon = if (copied) AllIcons.Actions.Checked else AllIcons.General.Error
            toolTipText = if (copied) COPY_TOOLTIP else COPY_FAILED_TOOLTIP
            val revert = Timer(COPY_FEEDBACK_MS) {
                icon = AllIcons.Actions.Copy
                toolTipText = COPY_TOOLTIP
            }
            revert.isRepeats = false
            revert.start()
        }
    }

/**
 * Copy affordance under one answer, hugging the right edge through its own FlowLayout.RIGHT: in a
 * BoxLayout Y_AXIS column a child with a different alignmentX is offset, which indents the column.
 */
internal fun copyRow(source: () -> String): JPanel =
    object : JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)) {
        // Otherwise the column hands this row any leftover vertical space.
        override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
    }.apply {
        isOpaque = false
        border = JBUI.Borders.empty(0, 8, 2, 8)
        alignmentX = 0.5f
        add(copyButton(null, source))
    }

/**
 * One question-answer turn in the transcript. All mutation methods must run on the EDT;
 * [ChatPanel]'s coroutine callbacks hop back via `invokeLater` before touching this class.
 */
class TurnPanel(private val project: Project, question: String) {

    val component = JBPanel<JBPanel<*>>().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        border = JBUI.Borders.empty(6, 8)
    }

    private val questionLabel = wrappingHtml(questionHtml(question))

    /**
     * The question reads as a bubble. Only the question is tinted: [SqlBlockPanel]'s editor,
     * [ResultTablePanel]'s table and the progress icon all paint their own backgrounds.
     */
    private val questionBubble = object : JPanel(BorderLayout()) {
        // Otherwise the column hands the bubble any leftover vertical space.
        override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
    }.apply {
        isOpaque = true
        background = QUESTION_BUBBLE_BACKGROUND
        border = JBUI.Borders.compound(
            JBUI.Borders.customLine(QUESTION_BUBBLE_BORDER, 1),
            JBUI.Borders.empty(6, 8),
        )
        add(questionLabel, BorderLayout.CENTER)
    }
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

    /** Set by [TranscriptView]: a turn keeps growing after it is added. */
    internal var onContentAppended: (() -> Unit)? = null

    private fun refresh() {
        component.revalidate()
        component.repaint()
        onContentAppended?.invoke()
    }

    init {
        // BoxLayout Y_AXIS aligns children by alignmentX; keep every row left-aligned so nothing indents.
        questionLabel.alignmentX = 0f
        questionBubble.alignmentX = 0f
        statusRow.alignmentX = 0f
        bodyPanel.alignmentX = 0f
        component.add(roleHeader("You", com.intellij.icons.AllIcons.General.User, rightAligned = true))
        component.add(questionBubble)
        component.add(javax.swing.Box.createVerticalStrut(8))
        component.add(roleHeader("AskSQL", AskSqlIcons.ASSISTANT))
        component.add(statusRow)
        component.add(bodyPanel)
    }

    /**
     * A small "You"/"AskSQL" row above each side of the turn. The user's row hugs the right edge
     * through its own FlowLayout.RIGHT while keeping alignmentX 0f: mixing alignmentX values in a
     * BoxLayout column indents it.
     */
    private fun roleHeader(name: String, icon: javax.swing.Icon, rightAligned: Boolean = false): JPanel =
        JPanel(FlowLayout(if (rightAligned) FlowLayout.RIGHT else FlowLayout.LEFT, 4, 0)).apply {
            isOpaque = false
            border = JBUI.Borders.emptyBottom(2)
            alignmentX = 0f
            val nameLabel = JBLabel(name).apply { font = font.deriveFont(java.awt.Font.BOLD); foreground = com.intellij.ui.JBColor.GRAY }
            // Mirrored so the icon stays on the outer edge of each side.
            if (rightAligned) {
                add(nameLabel)
                add(JBLabel(icon))
            } else {
                add(JBLabel(icon))
                add(nameLabel)
            }
        }

    fun updateStatus(text: String) {
        statusLabel.text = text
        val busy = text.isNotBlank()
        statusIcon.isVisible = busy
        if (busy) {
            announce(text)
            statusIcon.resume()
        } else {
            statusIcon.suspend()
        }
    }

    /**
     * Setting the label's text fires only ACCESSIBLE_VISIBLE_DATA_PROPERTY, which no reader speaks
     * for an unfocused, non-focusable label; the platform announcer speaks it, queued so a run of
     * stage labels is not clipped. Off the JBR there is no announcer and this is a no-op.
     */
    private fun announce(message: String) {
        if (ScreenReader.isActive() && AccessibleAnnouncerUtil.isAnnouncingAvailable()) {
            AccessibleAnnouncerUtil.announce(statusLabel, message, false)
        }
    }

    fun showSqlPendingApproval(sql: String, explanation: String? = null, onRun: () -> Unit, onCancel: () -> Unit) {
        bodyPanel.removeAll()
        val stack = JPanel()
        stack.layout = BoxLayout(stack, BoxLayout.Y_AXIS)
        stack.add(SqlBlockPanel(project, sql).component)
        explanation?.takeIf { it.isNotBlank() }?.let {
            stack.add(wrappingHtml("<i>${markdownToHtml(it)}</i>").apply { border = JBUI.Borders.empty(4, 2) })
            stack.add(copyRow { it })
            explanationShown = true
        }
        stack.add(ApprovalBar(onRun, onCancel).component)
        bodyPanel.add(stack)
        refresh()
    }

    fun showSqlOnly(sql: String, explanation: String?) {
        bodyPanel.removeAll()
        bodyPanel.add(SqlBlockPanel(project, sql).component)
        // Stashed, not shown yet: showResult appends it AFTER the result table, so a turn reads question, query, result, explanation.
        pendingAskExplanation = explanation
        refresh()
    }

    /** The block shows the pipeline JSON but copies the full shell call, so a paste into mongosh runs. */
    private fun mongoBlock(collection: String, pipelineJson: String) =
        SqlBlockPanel(
            project,
            pipelineJson,
            fileExtension = "json",
            languageId = "JSON",
            clipboardText = mongoShellSnippet(collection, pipelineJson),
        )

    /** MongoDB counterpart to [showSqlPendingApproval]; the collection sits above the block. */
    fun showMongoPipelinePendingApproval(collection: String, pipelineJson: String, explanation: String? = null, onRun: () -> Unit, onCancel: () -> Unit) {
        bodyPanel.removeAll()
        val stack = JPanel()
        stack.layout = BoxLayout(stack, BoxLayout.Y_AXIS)
        stack.add(selectableText("Collection: $collection"))
        stack.add(mongoBlock(collection, pipelineJson).component)
        explanation?.takeIf { it.isNotBlank() }?.let {
            stack.add(wrappingHtml("<i>${markdownToHtml(it)}</i>").apply { border = JBUI.Borders.empty(4, 2) })
            stack.add(copyRow { it })
            explanationShown = true
        }
        stack.add(ApprovalBar(onRun, onCancel).component)
        bodyPanel.add(stack)
        refresh()
    }

    /** MongoDB counterpart to [showSqlOnly]. */
    fun showMongoPipelineOnly(collection: String, pipelineJson: String, explanation: String?) {
        bodyPanel.removeAll()
        val stack = JPanel()
        stack.layout = BoxLayout(stack, BoxLayout.Y_AXIS)
        stack.add(selectableText("Collection: $collection"))
        stack.add(mongoBlock(collection, pipelineJson).component)
        bodyPanel.add(stack)
        pendingAskExplanation = explanation
        refresh()
    }

    private var explanationShown = false
    /** Toggles the Explain button between idle and in-flight; null until [showResult] builds one. */
    private var applyExplainState: ((ExplainState) -> Unit)? = null
    /** The button is shared by the click path and the automatic one, so it only idles when both are done. */
    private var explainsInFlight = 0

    /** Called by every explain request for this turn, automatic or clicked. */
    fun explainStarted() {
        explainsInFlight++
        applyExplainState?.invoke(ExplainState.BUSY)
    }

    private fun explainSettled(succeeded: Boolean) {
        if (explainsInFlight > 0) explainsInFlight--
        applyExplainState?.invoke(explainStateAfter(explainsInFlight, succeeded))
    }
    /** The failure currently shown for this turn: its label and copy row. */
    private var failureLabel: JEditorPane? = null
    private var failureCopyRow: JPanel? = null

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
        toolbar.add(JButton("Copy", AllIcons.Actions.Copy).apply { addActionListener { onCopyResult(panel) } })
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
            // The turn's spinner sits above a tall result, so the button itself carries the in-flight state.
            val explainButton = JButton("Explain")
            explainButton.preferredSize = Dimension(
                explainButton.getFontMetrics(explainButton.font).stringWidth(EXPLAIN_BUSY_TEXT) + JBUI.scale(28),
                explainButton.preferredSize.height,
            )
            applyExplainState = { state ->
                explainButton.isEnabled = state == ExplainState.IDLE
                explainButton.text = if (state == ExplainState.BUSY) EXPLAIN_BUSY_TEXT else "Explain"
                explainButton.toolTipText = if (state == ExplainState.DONE) EXPLAIN_DONE_TOOLTIP else null
            }
            // The automatic explain may have started, or finished, before this button existed.
            if (explainsInFlight > 0) applyExplainState?.invoke(ExplainState.BUSY)
            else if (explanationShown) applyExplainState?.invoke(ExplainState.DONE)
            explainButton.addActionListener { onExplain() }
            toolbar.add(explainButton)
        }
        warningsLabel(resultSet.warnings)?.let { toolbar.add(it) }

        wrapper.add(toolbar, BorderLayout.SOUTH)

        bodyPanel.add(wrapper)
        pendingAskExplanation?.let { explanation ->
            if (explanation.isNotBlank()) {
                bodyPanel.add(wrappingHtml("<i>${markdownToHtml(explanation)}</i>").apply { border = JBUI.Borders.empty(4, 2) })
                bodyPanel.add(copyRow { explanation })
                explanationShown = true
            }
            pendingAskExplanation = null
        }
        refresh()
    }

    /** True once any description has been shown for this turn (inline prose or a dedicated Explain call); lets the caller skip a redundant auto-explain. */
    fun hasExplanation(): Boolean = explanationShown

    /** Renders an answer with each fenced block as a real code block with its own Copy, bounded in height. */
    private fun addProseWithCodeBlocks(text: String, defaultIsJson: Boolean, extracted: String? = null): Int {
        var blocks = 0
        for (segment in splitFencedSegments(text)) {
            when (segment) {
                is AnswerSegment.Prose ->
                    bodyPanel.add(wrappingHtml(markdownToHtml(segment.text)).apply { border = JBUI.Borders.empty(6, 8) })
                is AnswerSegment.Code -> if (blocks < MAX_INLINE_CODE_BLOCKS) {
                    blocks++
                    val (extension, language) = fenceLanguage(segment.tag, defaultIsJson)
                    // The extracted statement has had trailing prose stripped.
                    val code = extracted?.takeIf { segment.code.trim().startsWith(it.trim()) }?.trim() ?: segment.code
                    bodyPanel.add(boundedBlock(SqlBlockPanel(project, code, fileExtension = extension, languageId = language).component))
                } else {
                    bodyPanel.add(wrappingHtml(markdownToHtml("```\n${segment.code}\n```")).apply { border = JBUI.Borders.empty(6, 8) })
                }
            }
        }
        return blocks
    }

    /** Bounded height: [SqlBlockPanel]'s panel has an unbounded maximum. */
    private fun boundedBlock(component: JPanel): JPanel =
        object : JPanel(BorderLayout()) {
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
        }.apply { isOpaque = false; add(component, BorderLayout.CENTER) }

    /** Appends the model's plain-language explanation below the result; called by the "Explain" button or the auto-explain path. */
    fun appendExplanation(text: String) {
        explanationShown = true
        addProseWithCodeBlocks(text, defaultIsJson = false)
        bodyPanel.add(copyRow { text })
        explainSettled(succeeded = true)
        refresh()
    }

    fun showExplanationError(userMessage: String) {
        appendExplanation("Couldn't explain this query: $userMessage")
        explainSettled(succeeded = false)
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
        val blocks = addProseWithCodeBlocks(answer, defaultIsJson = proposedIsPipeline, extracted = proposedSql)
        // The model can propose a statement without fencing it.
        if (blocks == 0 && proposedSql != null) {
            val (extension, language) = fenceLanguage(if (proposedIsPipeline) "json" else "sql", proposedIsPipeline)
            bodyPanel.add(boundedBlock(SqlBlockPanel(project, proposedSql, fileExtension = extension, languageId = language).component))
        }
        if (unknownReferences.isNotEmpty()) {
            val names = escapeHtml(unknownReferences.joinToString(", "))
            val note = if (isSchemaChange) {
                "<i>Proposed names not in your current schema: $names.</i>"
            } else {
                "<i>Heads up: this mentioned names not in your schema ($names), so treat those with caution.</i>"
            }
            bodyPanel.add(wrappingHtml(note).apply { border = JBUI.Borders.empty(2, 8) })
        }
        if (!answer.contains(READ_ONLY_LINE_MARKER)) {
            bodyPanel.add(
                wrappingHtml("<i>Generated from your schema by the model - no query was run, so treat it as guidance.</i>")
                    .apply { border = JBUI.Borders.empty(2, 8) },
            )
        }
        // One row for the whole answer: the clipboard gets the model's text, not the notes around it.
        bodyPanel.add(copyRow { answer })
        refresh()
    }

    fun showError(userMessage: String) {
        updateStatus("")
        showFailure(wrappingHtml(errorHtml(userMessage)), userMessage)
    }

    /** A turn has at most one outcome: a new failure replaces the previous one, and a real result clears it. */
    private fun showFailure(label: JEditorPane, message: String) {
        clearFailure()
        failureLabel = label
        val copy = copyRow { message }
        failureCopyRow = copy
        bodyPanel.add(label)
        bodyPanel.add(copy)
        refresh()
    }

    private fun clearFailure() {
        failureLabel?.let { bodyPanel.remove(it) }
        failureCopyRow?.let { bodyPanel.remove(it) }
        failureLabel = null
        failureCopyRow = null
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
        showFailure(label, userMessage)
        refresh()
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
            block = mongoBlock(collection, pipelineJson).component,
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
        failureCopyRow = null
        // Clears the rejected query's explanation; the caller auto-explains the corrected one.
        pendingAskExplanation = null
        explanationShown = false
        val stack = JPanel()
        stack.layout = BoxLayout(stack, BoxLayout.Y_AXIS)
        stack.add(wrappingHtml(errorHtml(errorMessage)).apply { border = JBUI.Borders.empty(2) })
        stack.add(selectableText(heading).apply { border = JBUI.Borders.empty(6, 2, 2, 2) })
        stack.add(block)
        // Dismiss drops the stack; the caller re-shows the error.
        stack.add(ApprovalBar(onRunFix, { bodyPanel.remove(stack); onDismiss() }).component)
        bodyPanel.add(stack)
        refresh()
    }


    /**
     * A rich-text label that word-wraps, unlike [JBLabel] with HTML content. Its height is measured
     * against the width the column gives it, not its natural unwrapped width.
     */
    private fun wrappingHtml(innerHtml: String): JEditorPane =
        object : JEditorPane("text/html", "<html><body>$innerHtml</body></html>") {
            private var wrappedWidth = -1

            /**
             * On a resize this pane is measured before its own width has caught up, so the height
             * comes from the width it wrapped at last time; a second measure after that pass settles it.
             */
            override fun setBounds(x: Int, y: Int, w: Int, h: Int) {
                val rewrapped = w != wrappedWidth
                super.setBounds(x, y, w, h)
                if (!rewrapped) return
                wrappedWidth = w
                javax.swing.SwingUtilities.invokeLater {
                    invalidate()
                    revalidate()
                    repaint()
                }
            }

            /**
             * The width this pane will be given. A turn is measured before anything in it has bounds,
             * so the column is the first ancestor with a width; the pane is stretched to that, less
             * the borders in between.
             */
            private fun wrapWidth(): Int {
                var borders = insets.left + insets.right
                if (width > 0) return width - borders
                var ancestor: java.awt.Container? = parent
                while (ancestor != null) {
                    val ancestorInsets = ancestor.insets
                    if (ancestor.width > 0) {
                        return ancestor.width - ancestorInsets.left - ancestorInsets.right - borders
                    }
                    borders += ancestorInsets.left + ancestorInsets.right
                    ancestor = ancestor.parent
                }
                return 0
            }

            override fun getPreferredSize(): Dimension {
                val insets = insets
                val inner = wrapWidth()
                // Nothing is sized yet: the natural, unwrapped size is the only answer available.
                if (inner <= 0) return super.getPreferredSize()
                // getUI(), not the inherited `ui` field: that one is typed ComponentUI and has no root view.
                val root = getUI().getRootView(this)
                root.setSize(inner.toFloat(), 0f)
                return Dimension(
                    inner + insets.left + insets.right,
                    root.getPreferredSpan(View.Y_AXIS).toInt() + insets.top + insets.bottom,
                )
            }

            // Otherwise the column hands the pane its leftover vertical space.
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
        }.apply {
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
