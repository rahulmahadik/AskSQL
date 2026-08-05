package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.rahulmahadik.asksql.ide.AskSqlEngineService
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.engine.MongoPrompts
import com.rahulmahadik.asksql.ide.engine.Prompts
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.errors.ErrorPresenter
import com.rahulmahadik.asksql.ide.model.EngineEvent
import com.rahulmahadik.asksql.ide.model.Stage
import com.rahulmahadik.asksql.ide.settings.AskSqlAppSettings
import com.rahulmahadik.asksql.ide.settings.AskSqlSecrets
import com.rahulmahadik.asksql.ide.settings.AskSqlSettingsListener
import com.rahulmahadik.asksql.ide.settings.ConnectionMerger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.event.ActionEvent
import javax.swing.AbstractAction
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.KeyStroke
import javax.swing.SwingUtilities

/** Formats [ChatPanel]'s model-label text. Pure (no Settings/Project access) so [ChatPanelModelLabelTest] can cover it. */
internal fun formatModelLabel(provider: com.rahulmahadik.asksql.ide.llm.ProviderKind?, model: String): String =
    if (provider != null && model.isNotBlank()) "Model: ${provider.wireName} · $model" else "Model: not configured"

/**
 * The Chat tab: connection/model pickers, transcript, and question input. Owns a UI-lifetime
 * [CoroutineScope] (a plain Swing component has no platform-injected scope), cancelled in [dispose].
 */
class ChatPanel(private val project: Project) : Disposable {

    val component = JPanel(BorderLayout())

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** The turn's single in-flight job (ask, then the follow-up execute); see [beginBusy]. Volatile: handoff reassigns it off the EDT. */
    @Volatile
    private var activeJob: Job? = null

    private val transcript = TranscriptView(project) { question -> inputArea.text = question; submitQuestion() }
    /** Min width so it doesn't render as a sliver before [refresh] populates it. */
    private val connectionCombo = JComboBox<ConnectionDescriptor>().apply {
        val minWidth = 180
        minimumSize = java.awt.Dimension(minWidth, minimumSize.height)
        preferredSize = java.awt.Dimension(maxOf(minWidth, preferredSize.width), preferredSize.height)
    }
    /** Enter submits, Shift+Enter inserts a newline. */
    private val inputArea = JBTextArea(3, 40).apply {
        lineWrap = true
        wrapStyleWord = true
        border = com.intellij.util.ui.JBUI.Borders.empty(6, 8)
        val submitKey = "askSql.submitQuestion"
        getInputMap(JComponent.WHEN_FOCUSED).put(KeyStroke.getKeyStroke("ENTER"), submitKey)
        getInputMap(JComponent.WHEN_FOCUSED).put(KeyStroke.getKeyStroke("shift ENTER"), "insert-break")
        actionMap.put(submitKey, object : AbstractAction() {
            override fun actionPerformed(e: ActionEvent) {
                submitQuestion()
            }
        })
    }
    // EDT-confined: read via a snapshot before each background ask, appended back on the EDT.
    private var contextTurns = ArrayDeque<Prompts.ContextTurn>()
    private var mongoContextTurns = ArrayDeque<MongoPrompts.ContextTurn>()
    /** Tracks the previously selected connection so switching databases clears the stale conversation history. */
    private var lastSelectedConnectionId: String? = null

    /** A single button that toggles Ask/Cancel rather than two side-by-side buttons; see [beginBusy]/[endBusy]. */
    private val askButton = JButton("Ask", com.intellij.icons.AllIcons.Actions.Execute).apply {
        // Sized for the wider "Cancel" label so the row doesn't jump when the button toggles.
        val width = getFontMetrics(font).stringWidth("Cancel") + com.intellij.util.ui.JBUI.scale(44)
        preferredSize = java.awt.Dimension(width, preferredSize.height)
        minimumSize = java.awt.Dimension(width, minimumSize.height)
    }
    /** Target of the currently selected connection ("mysql · host:port/db"); the combo shows only the name. */
    private val connectionDetailLabel = javax.swing.JLabel().apply {
        foreground = com.intellij.ui.JBColor.GRAY
        font = com.intellij.util.ui.JBUI.Fonts.smallFont()
    }
    /** Shows the currently configured provider/model. Click to open Settings. */
    private val modelLabel = javax.swing.JLabel().apply {
        // Small and muted rather than competing with the connection picker.
        foreground = com.intellij.ui.JBColor.GRAY
        font = com.intellij.util.ui.JBUI.Fonts.smallFont()
        cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        toolTipText = "Click to change the AI provider/model"
        addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) {
                com.rahulmahadik.asksql.ide.settings.AskSqlConfigurableOpener.open(project)
                refresh()
            }
        })
    }

    private val onboardingCard = JPanel(BorderLayout())
    private val chatCard = JPanel(BorderLayout())

    init {
        // ConnectionDescriptor#toString is the data class default, so this renderer draws the name itself.
        connectionCombo.renderer = object : javax.swing.DefaultListCellRenderer() {
            override fun getListCellRendererComponent(
                list: javax.swing.JList<*>?, value: Any?, index: Int, isSelected: Boolean, cellHasFocus: Boolean,
            ): java.awt.Component {
                val label = (value as? ConnectionDescriptor)?.name ?: value?.toString().orEmpty()
                return super.getListCellRendererComponent(list, label, index, isSelected, cellHasFocus)
            }
        }
        connectionCombo.addActionListener { onConnectionSelectionChanged() }
        buildChatCard()
        component.add(onboardingCard, BorderLayout.CENTER)
        refresh()
        // Settings can also be opened from the IDE Settings menu, not just this tab's onboarding buttons.
        project.messageBus.connect(this).subscribe(AskSqlSettingsListener.TOPIC, AskSqlSettingsListener { refresh() })
    }

    /** Re-checks connection/provider configuration and swaps the empty state in or out. Call after settings change. */
    fun refresh() {
        val descriptors = ConnectionMerger.merged(project).map { it.descriptor }
        val hasConnection = descriptors.isNotEmpty()
        val hasProvider = AskSqlAppSettings.getInstance().provider.isNotBlank() && AskSqlAppSettings.getInstance().model.isNotBlank()

        connectionCombo.removeAllItems()
        descriptors.forEach { connectionCombo.addItem(it) }
        updateModelLabel()
        onConnectionSelectionChanged()

        component.removeAll()
        if (!hasConnection || !hasProvider) {
            val onboarding = OnboardingPanel(
                hasConnection = hasConnection,
                hasProvider = hasProvider,
                onAddConnection = { com.rahulmahadik.asksql.ide.actions.AddConnectionAction.showWizard(project) { refresh() } },
                onTrySampleData = { com.rahulmahadik.asksql.ide.actions.TrySampleDataAction.createSampleConnection(project) { refresh() } },
                // showSettingsDialog is modal, so refresh() runs after the dialog closes.
                onUseLocalModel = { com.rahulmahadik.asksql.ide.settings.AskSqlConfigurableOpener.openWithLocalModelHint(project); refresh() },
                onConfigureProvider = { com.rahulmahadik.asksql.ide.settings.AskSqlConfigurableOpener.open(project); refresh() },
            )
            component.add(onboarding.component, BorderLayout.CENTER)
        } else {
            component.add(chatCard, BorderLayout.CENTER)
            consumePendingQuestion()
        }
        component.revalidate()
        component.repaint()
    }

    /** Keeps [modelLabel] in sync with [AskSqlAppSettings]; called from [refresh]. */
    private fun updateModelLabel() {
        val settings = AskSqlAppSettings.getInstance()
        val provider = settings.provider.takeIf { it.isNotBlank() }?.let {
            runCatching { com.rahulmahadik.asksql.ide.llm.ProviderKind.valueOf(it) }.getOrNull()
        }
        modelLabel.text = formatModelLabel(provider, settings.model)
    }

    /** Keeps [connectionDetailLabel] in sync, and clears conversation history on a REAL switch to a different connection. */
    private fun onConnectionSelectionChanged() {
        val selected = connectionCombo.selectedItem as? ConnectionDescriptor
        connectionDetailLabel.text = selected?.let { "${it.engine.wireName} · ${it.target()}" } ?: ""
        val selectedId = selected?.id
        if (selectedId != null && lastSelectedConnectionId != null && selectedId != lastSelectedConnectionId) {
            transcript.clear()
            contextTurns.clear()
            mongoContextTurns.clear()
        }
        lastSelectedConnectionId = selectedId
    }

    /** Picks up a question stashed by [com.rahulmahadik.asksql.ide.actions.AskAboutSelectionAction], which also calls this directly. */
    fun consumePendingQuestion() {
        PendingQuestion.consume(project)?.let { pending ->
            inputArea.text = pending
            inputArea.requestFocusInWindow()
        }
    }

    /** Flips Ask into Cancel; one button, not two. */
    /** The input stays editable mid-answer; only submitting is blocked (see [submitQuestion]). */
    private fun beginBusy(job: Job) {
        activeJob = job
        onEdt {
            askButton.text = "Cancel"
            askButton.icon = com.intellij.icons.AllIcons.Actions.Suspend
        }
    }

    private fun endBusy() {
        activeJob = null
        onEdt {
            askButton.text = "Ask"
            askButton.icon = com.intellij.icons.AllIcons.Actions.Execute
        }
    }

    /** Called by [com.rahulmahadik.asksql.ide.actions.ClearChatAction]; the button lives in the tool window title bar. */
    fun clearConversation() {
        val confirmed = com.intellij.openapi.ui.Messages.showYesNoDialog(
            project,
            "Clear the whole conversation? This can't be undone.",
            "Clear Conversation",
            com.intellij.openapi.ui.Messages.getQuestionIcon(),
        ) == com.intellij.openapi.ui.Messages.YES
        if (confirmed) {
            transcript.clear()
            contextTurns.clear()
            mongoContextTurns.clear()
        }
    }

    private fun buildChatCard() {
        // The picker leads with Clear opposite it, and the connection target plus model sit underneath.
        val toolbar = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }

        val clearButton = JButton(com.intellij.icons.AllIcons.Actions.GC).apply {
            toolTipText = "Clear this conversation"
            addActionListener { clearConversation() }
        }
        val pickerGroup = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
            isOpaque = false
            add(javax.swing.JLabel("Connection:"))
            add(connectionCombo)
        }
        val connectionRow = JPanel(BorderLayout()).apply {
            alignmentX = 0f
            border = com.intellij.util.ui.JBUI.Borders.empty(2, 6, 0, 4)
            add(pickerGroup, BorderLayout.WEST)
            add(clearButton, BorderLayout.EAST)
        }

        val detailRow = JPanel(BorderLayout()).apply {
            alignmentX = 0f
            border = com.intellij.util.ui.JBUI.Borders.empty(0, 6, 3, 6)
            add(connectionDetailLabel, BorderLayout.WEST)
            add(modelLabel, BorderLayout.EAST)
        }

        toolbar.add(connectionRow)
        toolbar.add(detailRow)

        val inputPanel = JPanel(BorderLayout())
        inputPanel.border = com.intellij.util.ui.JBUI.Borders.empty(4, 8, 0, 8)
        inputPanel.add(JBScrollPane(inputArea), BorderLayout.CENTER)
        askButton.addActionListener { if (activeJob != null) activeJob?.cancel() else submitQuestion() }
        // BorderLayout.CENTER, not a glue-pushed column, so the button matches the input's full height.
        val buttonColumn = JPanel(BorderLayout()).apply {
            border = com.intellij.util.ui.JBUI.Borders.emptyLeft(6)
            add(askButton, BorderLayout.CENTER)
        }
        inputPanel.add(buttonColumn, BorderLayout.EAST)

        chatCard.add(toolbar, BorderLayout.NORTH)
        chatCard.add(transcript.component, BorderLayout.CENTER)
        chatCard.add(inputPanel, BorderLayout.SOUTH)
    }

    private fun submitQuestion() {
        if (activeJob != null) return // a turn is in flight; Cancel it first
        val question = inputArea.text.trim()
        if (question.isEmpty()) return
        val descriptor = connectionCombo.selectedItem as? ConnectionDescriptor
        if (descriptor == null) return
        inputArea.text = ""

        val turn = TurnPanel(project, question)
        transcript.addTurn(turn)
        val sqlContext = contextTurns.toList()
        val mongoContext = mongoContextTurns.toList()

        val job = scope.launch {
            val engineService = AskSqlEngineService.getInstance(project)
            // Set synchronously, not inside the onEdt{} lambdas below: the finally block reads it before those run.
            var handedOffToExecute = false
            try {
                val password = AskSqlSecrets.getDbPassword(descriptor)
                val llmClient = engineService.currentLlmClient()
                val requireApproval = AskSqlAppSettings.getInstance().requireApproval

                if (descriptor.engine.isSql) {
                    val result = try {
                        engineService.pipeline.ask(
                            question = question,
                            descriptor = descriptor,
                            password = password,
                            llmClient = llmClient,
                            context = sqlContext,
                            onEvent = { event -> onEngineEvent(turn, event) },
                            customInstructions = AskSqlAppSettings.getInstance().customInstructions,
                            glossaryText = AskSqlAppSettings.getInstance().glossary,
                        )
                    } catch (e: Exception) {
                        // Schema-understanding fallback: answer a conceptual question from the schema in prose.
                        val code = ErrorPresenter.present(e).code
                        if (
                            AskSqlAppSettings.getInstance().answerSchemaQuestions &&
                            (code == AskSqlErrorCode.LLM_CANNOT_ANSWER || code == AskSqlErrorCode.LLM_REFUSAL)
                        ) {
                            val sa = engineService.pipeline.explainSchema(question, descriptor, password, llmClient, sqlContext)
                            onEdt { turn.showSchemaAnswer(sa.answer, sa.unknownReferences, sa.isSchemaChange, sa.proposedSql) }
                            // A prose turn is still a turn: without it, "run that query" has nothing to refer to.
                            sa.proposedSql?.let {
                                contextTurns.addLast(Prompts.ContextTurn(question, it))
                                while (contextTurns.size > 6) contextTurns.removeFirst()
                            }
                            return@launch
                        }
                        throw e
                    }
                    if (requireApproval) {
                        onEdt {
                            turn.showSqlPendingApproval(
                                sql = result.sql,
                                explanation = result.explanation,
                                onRun = { runApprovedSql(turn, descriptor, password, result.sql, question) },
                                onCancel = { turn.showError("Cancelled."); endBusy() },
                            )
                        }
                    } else {
                        onEdt { turn.showSqlOnly(result.sql, result.explanation) }
                        handedOffToExecute = true
                        runApprovedSql(turn, descriptor, password, result.sql, question)
                    }
                    onEdt {
                        contextTurns.addLast(Prompts.ContextTurn(question, result.sql))
                        while (contextTurns.size > 6) contextTurns.removeFirst()
                    }
                } else {
                    val result = try {
                        engineService.mongoPipeline.ask(
                            question = question,
                            descriptor = descriptor,
                            password = password,
                            llmClient = llmClient,
                            context = mongoContext,
                            onEvent = { event -> onEngineEvent(turn, event) },
                            customInstructions = AskSqlAppSettings.getInstance().customInstructions,
                        )
                    } catch (e: Exception) {
                        // Same schema-understanding fallback the SQL branch has, in MongoDB terms.
                        val code = ErrorPresenter.present(e).code
                        if (
                            AskSqlAppSettings.getInstance().answerSchemaQuestions &&
                            (code == AskSqlErrorCode.LLM_CANNOT_ANSWER || code == AskSqlErrorCode.LLM_REFUSAL)
                        ) {
                            val sa = engineService.mongoPipeline.explainSchema(question, descriptor, password, llmClient, mongoContext)
                            onEdt { turn.showSchemaAnswer(sa.answer, sa.unknownReferences, sa.isSchemaChange, sa.proposedSql, proposedIsPipeline = true) }
                            return@launch
                        }
                        throw e
                    }
                    if (requireApproval) {
                        onEdt {
                            turn.showMongoPipelinePendingApproval(
                                collection = result.collection,
                                pipelineJson = result.pipelineJson,
                                explanation = result.explanation,
                                onRun = { runApprovedMongoPipeline(turn, descriptor, password, result.collection, result.pipelineJson, question) },
                                onCancel = { turn.showError("Cancelled."); endBusy() },
                            )
                        }
                    } else {
                        onEdt { turn.showMongoPipelineOnly(result.collection, result.pipelineJson, result.explanation) }
                        handedOffToExecute = true
                        runApprovedMongoPipeline(turn, descriptor, password, result.collection, result.pipelineJson, question)
                    }
                    onEdt {
                        mongoContextTurns.addLast(MongoPrompts.ContextTurn(question, result.pipelineJson))
                        while (mongoContextTurns.size > 6) mongoContextTurns.removeFirst()
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                onEdt { turn.updateStatus(""); turn.showCannotAnswer("Cancelled.", leadIn = null) }
            } catch (e: Exception) {
                val presented = ErrorPresenter.present(e)
                onEdt { presentAskFailure(turn, presented) }
            } finally {
                if (!handedOffToExecute) endBusy()
            }
        }
        beginBusy(job)
    }

    /** Routes an ask-phase failure: a legitimate "can't answer"/refusal gets the calm muted panel (with a switch-model hint), everything else the red error. */
    private fun presentAskFailure(turn: TurnPanel, presented: AskSqlException) {
        val openSettings = { com.rahulmahadik.asksql.ide.settings.AskSqlConfigurableOpener.open(project); refresh() }
        when (presented.code) {
            AskSqlErrorCode.LLM_CANNOT_ANSWER -> turn.showCannotAnswer(presented.userMessage, onOpenSettings = openSettings)
            AskSqlErrorCode.LLM_REFUSAL -> turn.showCannotAnswer(presented.userMessage, leadIn = null, onOpenSettings = openSettings)
            else -> turn.showError(presented.userMessage)
        }
    }

    /** Runs an approved (or auto-run) query on a NEW tracked job via [beginBusy], so Stop covers the query itself. */
    private fun runApprovedSql(turn: TurnPanel, descriptor: ConnectionDescriptor, password: String?, sql: String, question: String) {
        val job = scope.launch {
            try {
                onEdt { turn.updateStatus("Running…") }
                val engineService = AskSqlEngineService.getInstance(project)
                val resultSet = engineService.pipeline.execute(sql, descriptor, password, question)
                onEdt {
                    turn.updateStatus("")
                    turn.showResult(
                        resultSet,
                        onExportCsv = { it.exportCsv() },
                        onCopyResult = { it.copyToClipboard() },
                        onOpenInEditor = { it.openInEditor() },
                        onExplain = { explainSql(turn, descriptor, password, sql) },
                    )
                    // Fetch a description when the model's reply carried no inline explanation.
                    if (!turn.hasExplanation() && AskSqlAppSettings.getInstance().explainAutomatically) {
                        explainSql(turn, descriptor, password, sql)
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                onEdt { turn.updateStatus(""); turn.showCannotAnswer("Cancelled.", leadIn = null) }
            } catch (e: Exception) {
                val presented = ErrorPresenter.present(e)
                onEdt { turn.updateStatus("") }
                // Only a query the DATABASE itself rejected is worth asking the model to repair.
                if (presented.code == AskSqlErrorCode.DB_QUERY_ERROR) {
                    trySuggestSqlFix(turn, descriptor, password, sql, question, presented)
                } else {
                    onEdt { turn.showError(presented.userMessage) }
                }
            } finally {
                endBusy()
            }
        }
        beginBusy(job)
    }

    /**
     * The database's own words appended to the friendly line. DB_QUERY_ERROR only: a connection
     * failure's detail carries the host and user.
     */
    private fun dbErrorText(presented: AskSqlException): String {
        if (presented.code != AskSqlErrorCode.DB_QUERY_ERROR) return presented.userMessage
        val detail = presented.detail
            ?.lineSequence()?.firstOrNull()
            // MariaDB/MySQL prefix messages with the pooled connection number, which means nothing here.
            ?.replace(Regex("""^\s*\(conn=\d+\)\s*"""), "")
            ?.trim()
            ?.take(300)
            ?.takeIf { it.isNotEmpty() }
            ?: return presented.userMessage
        return "${presented.userMessage} $detail"
    }

    private suspend fun trySuggestSqlFix(turn: TurnPanel, descriptor: ConnectionDescriptor, password: String?, failedSql: String, question: String, presented: AskSqlException) {
        val engineService = AskSqlEngineService.getInstance(project)
        val fix = try {
            val llmClient = engineService.currentLlmClient()
            engineService.pipeline.suggestFix(
                failedSql = failedSql, descriptor = descriptor, password = password,
                question = question, errorDetail = presented.detail, llmClient = llmClient,
                customInstructions = AskSqlAppSettings.getInstance().customInstructions,
            )
        } catch (e: Exception) {
            null // best-effort; the original error stands, shown below
        }
        onEdt {
            if (fix != null) {
                turn.showErrorWithSuggestedSqlFix(
                    errorMessage = dbErrorText(presented), suggestedSql = fix,
                    onRunFix = { runApprovedSql(turn, descriptor, password, fix, question) },
                    onDismiss = { turn.showError(dbErrorText(presented)) },
                )
            } else {
                turn.showError(dbErrorText(presented))
            }
        }
    }

    private fun runApprovedMongoPipeline(turn: TurnPanel, descriptor: ConnectionDescriptor, password: String?, collection: String, pipelineJson: String, question: String) {
        val job = scope.launch {
            try {
                onEdt { turn.updateStatus("Running…") }
                val engineService = AskSqlEngineService.getInstance(project)
                val resultSet = engineService.mongoPipeline.execute(pipelineJson, collection, descriptor, password, question)
                onEdt {
                    turn.updateStatus("")
                    turn.showResult(
                        resultSet,
                        onExportCsv = { it.exportCsv() },
                        onCopyResult = { it.copyToClipboard() },
                        onOpenInEditor = { it.openInEditor() },
                        onExplain = { explainMongoPipeline(turn, descriptor, password, pipelineJson) },
                    )
                    if (!turn.hasExplanation() && AskSqlAppSettings.getInstance().explainAutomatically) {
                        explainMongoPipeline(turn, descriptor, password, pipelineJson)
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                onEdt { turn.updateStatus(""); turn.showCannotAnswer("Cancelled.", leadIn = null) }
            } catch (e: Exception) {
                val presented = ErrorPresenter.present(e)
                onEdt { turn.updateStatus("") }
                if (presented.code == AskSqlErrorCode.DB_QUERY_ERROR) {
                    trySuggestMongoFix(turn, descriptor, password, pipelineJson, question, presented)
                } else {
                    onEdt { turn.showError(presented.userMessage) }
                }
            } finally {
                endBusy()
            }
        }
        beginBusy(job)
    }

    private suspend fun trySuggestMongoFix(turn: TurnPanel, descriptor: ConnectionDescriptor, password: String?, failedPipeline: String, question: String, presented: AskSqlException) {
        val engineService = AskSqlEngineService.getInstance(project)
        val fix = try {
            val llmClient = engineService.currentLlmClient()
            engineService.mongoPipeline.suggestFix(
                failedPipeline = failedPipeline, descriptor = descriptor, password = password,
                question = question, errorDetail = presented.detail, llmClient = llmClient,
                customInstructions = AskSqlAppSettings.getInstance().customInstructions,
            )
        } catch (e: Exception) {
            null
        }
        onEdt {
            if (fix != null) {
                turn.showErrorWithSuggestedMongoFix(
                    errorMessage = dbErrorText(presented), collection = fix.collection, pipelineJson = fix.pipelineJson,
                    onRunFix = { runApprovedMongoPipeline(turn, descriptor, password, fix.collection, fix.pipelineJson, question) },
                    onDismiss = { turn.showError(dbErrorText(presented)) },
                )
            } else {
                turn.showError(dbErrorText(presented))
            }
        }
    }

    private fun onEngineEvent(turn: TurnPanel, event: EngineEvent) {
        onEdt {
            when (event) {
                is EngineEvent.StageEvent -> turn.updateStatus(stageLabel(event.stage))
                // Raw tokens are the model's unparsed reply; the stage label and spinner already show progress.
                is EngineEvent.Token -> Unit
                is EngineEvent.Warning -> turn.updateStatus(event.message)
                EngineEvent.Done -> turn.updateStatus("")
            }
        }
    }

    /** Matches the VS Code extension's `STAGE_LABEL` wording. */
    private fun stageLabel(stage: Stage): String = when (stage) {
        Stage.CATALOG -> "Reading schema…"
        Stage.PRUNE -> "Finding relevant tables…"
        Stage.LLM -> "Writing SQL…"
        Stage.REPAIR -> "Correcting the SQL…"
        Stage.EXTRACT -> "Reading the reply…"
        Stage.GUARD -> "Checking safety…"
        Stage.EXECUTE -> "Running the query…"
        Stage.DONE -> ""
    }

    private inline fun onEdt(crossinline block: () -> Unit) {
        if (SwingUtilities.isEventDispatchThread()) block() else ApplicationManager.getApplication().invokeLater { block() }
    }

    /** Shows the turn's spinner for the whole model round-trip. */
    private fun explainSql(turn: TurnPanel, descriptor: ConnectionDescriptor, password: String?, sql: String) {
        scope.launch {
            onEdt { turn.updateStatus("Describing the query…") }
            try {
                val engineService = AskSqlEngineService.getInstance(project)
                val llmClient = engineService.currentLlmClient()
                val explanation = engineService.pipeline.explain(sql, descriptor, password, llmClient)
                onEdt { turn.updateStatus(""); turn.appendExplanation(explanation) }
            } catch (e: Exception) {
                val presented = ErrorPresenter.present(e)
                onEdt { turn.updateStatus(""); turn.showExplanationError(presented.userMessage) }
            }
        }
    }

    private fun explainMongoPipeline(turn: TurnPanel, descriptor: ConnectionDescriptor, password: String?, pipelineJson: String) {
        scope.launch {
            onEdt { turn.updateStatus("Describing the pipeline…") }
            try {
                val engineService = AskSqlEngineService.getInstance(project)
                val llmClient = engineService.currentLlmClient()
                val explanation = engineService.mongoPipeline.explain(pipelineJson, descriptor, password, llmClient)
                onEdt { turn.updateStatus(""); turn.appendExplanation(explanation) }
            } catch (e: Exception) {
                val presented = ErrorPresenter.present(e)
                onEdt { turn.updateStatus(""); turn.showExplanationError(presented.userMessage) }
            }
        }
    }

    override fun dispose() {
        scope.cancel()
    }
}
