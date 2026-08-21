package com.rahulmahadik.asksql.ide.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.ui.Messages
import com.intellij.ui.dsl.builder.Align
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.whenItemSelectedFromUi
import com.rahulmahadik.asksql.ide.errors.ErrorPresenter
import com.rahulmahadik.asksql.ide.llm.DefaultEndpoints
import com.rahulmahadik.asksql.ide.llm.LlmClients
import com.rahulmahadik.asksql.ide.llm.ProviderConfig
import com.rahulmahadik.asksql.ide.llm.ProviderKind
import com.rahulmahadik.asksql.ide.util.runBlockingWithProgress
import javax.swing.JComponent
import javax.swing.JPasswordField

/** Application-level Configurable: AI provider, model, key, and global engine defaults. */
class AskSqlConfigurable : Configurable {

    companion object {
        /** Set by [AskSqlConfigurableOpener.openWithLocalModelHint]; consumed once by [createComponent]. */
        var pendingLocalModelHint: Boolean = false
    }

    private val settings get() = AskSqlAppSettings.getInstance()
    private val defaults = AskSqlAppState() // for "Reset to defaults": the data class's own field defaults are the single source of truth

    private var providerField: ProviderKind? = settings.provider.takeIf { it.isNotBlank() }?.let { runCatching { ProviderKind.valueOf(it) }.getOrNull() }
    private var modelField: String = settings.model
    private var baseUrlField: String = settings.baseUrl.orEmpty()
    private var maxRowsField: Int = settings.maxRows
    private var maxSchemaTokensField: Int = settings.maxSchemaTokens
    private var requireApprovalField: Boolean = settings.requireApproval
    private var explainAutomaticallyField: Boolean = settings.explainAutomatically
    private var allowDataInPromptField: Boolean = settings.allowDataInPrompt
    private var answerSchemaQuestionsField: Boolean = settings.answerSchemaQuestions
    private var customInstructionsField: String = settings.customInstructions
    private var glossaryField: String = settings.glossary
    private val apiKeyComponent = JPasswordField()

    /** Typed as DialogPanel so [resetToDefaults] can call its real `reset()`. */
    private var dialogPanel: com.intellij.openapi.ui.DialogPanel? = null

    /** Forces [apply] to persist after [resetToDefaults] clears `dialogPanel`'s modification baseline. */
    private var forcePersistOnNextApply = false

    override fun getDisplayName(): String = "AskSQL"

    override fun createComponent(): JComponent {
        val hint = pendingLocalModelHint
        pendingLocalModelHint = false
        // Migration for installs saved before this was caught: switching Ollama -> a hosted provider left
        // the old base URL behind, so "Groq" requests went to localhost and Test Provider reported success
        // with no key. That combination was never valid, so the stale override is dropped on open.
        providerField?.let { p ->
            if (p in LlmClients.HOSTED && baseUrlField.isNotBlank() && isLoopbackUrl(baseUrlField)) {
                baseUrlField = ""
            }
        }
        if (hint && providerField == null) {
            providerField = ProviderKind.OLLAMA
            baseUrlField = DefaultEndpoints.OLLAMA_BASE_URL
        }

        lateinit var modelComboBox: com.intellij.openapi.ui.ComboBox<String>
        lateinit var providerComboBox: com.intellij.openapi.ui.ComboBox<ProviderKind>
        lateinit var baseUrlTextField: javax.swing.JTextField

        val built = panel {
            group("AI Provider") {
                row("Provider:") {
                    providerComboBox = comboBox(ProviderKind.entries.toList())
                        .bindItem({ providerField }, { providerField = it })
                        .whenItemSelectedFromUi { p ->
                            // Switching provider must not carry the previous provider's model or base URL over.
                            baseUrlTextField.text = when (p) {
                                ProviderKind.OLLAMA -> DefaultEndpoints.OLLAMA_BASE_URL
                                ProviderKind.LM_STUDIO -> DefaultEndpoints.LM_STUDIO_BASE_URL
                                else -> "" // hosted providers use their default host
                            }
                            modelComboBox.removeAllItems()
                            modelComboBox.selectedItem = null
                        }
                        .comment(
                            "Which AI service generates SQL from your question. Ollama and LM Studio run " +
                                "locally - no API key, no data leaves this machine. NVIDIA uses NVIDIA's " +
                                "hosted NIM endpoint and needs an API key, like the other cloud providers.",
                        )
                        .component
                }
                // A key is needed before models can be listed, and a model before a connection can be
                // tested. Asking for the key three rows BELOW the Fetch button meant the natural
                // top-to-bottom pass fetched with no credentials and got an empty list back.
                row("API key:") {
                    cell(apiKeyComponent)
                }.comment(
                    "Stored only in the OS keychain via PasswordSafe - never written to disk in plain text " +
                        "or synced with IDE settings. Leave blank to keep the current key; not needed for " +
                        "Ollama/LM Studio.",
                )
                row("Base URL (optional override):") {
                    baseUrlTextField = textField().bindText({ baseUrlField }, { baseUrlField = it })
                        .comment(
                            "Required for Ollama (http://localhost:11434), LM Studio (http://localhost:1234), " +
                                "or any other OpenAI-compatible gateway. Leave blank to use the provider's " +
                                "default hosted endpoint.",
                        )
                        .component
                }
                row("Model:") {
                    modelComboBox = comboBox(if (modelField.isNotBlank()) listOf(modelField) else emptyList())
                        .bindItem({ modelField.takeIf { it.isNotBlank() } }, { modelField = it.orEmpty() })
                        .applyToComponent { isEditable = true } // model discovery is best-effort; typing a name always works
                        .component
                    button("Fetch Models") {
                        fetchModelsInto(providerComboBox, baseUrlTextField, modelComboBox)
                    }
                    button("Test Connection") {
                        testProvider(providerComboBox, baseUrlTextField, modelComboBox)
                    }.comment(
                        "Fetch Models lists what this provider currently offers - only models that can answer a " +
                            "question are shown, so speech and classifier models are left out. Pick one, then " +
                            "Test Connection to confirm it replies.",
                    )
                }
            }
            group("Engine defaults") {
                row("Max rows per query:") {
                    intTextField(1..100_000).bindIntText({ maxRowsField }, { maxRowsField = it })
                }.comment("A LIMIT is added automatically to any query that doesn't already have one at or below this cap.")
                row("Max schema tokens:") {
                    intTextField(1000..200_000).bindIntText({ maxSchemaTokensField }, { maxSchemaTokensField = it })
                }.comment("Schema text sent to the model (estimate at ~4 chars/token). Raise it for large schemas with many joins; lower it for limited-context models. A 200-table schema costs roughly 10,000.")
                row {
                    checkBox("Require explicit approval before running generated SQL")
                        .bindSelected({ requireApprovalField }, { requireApprovalField = it })
                        .comment("Off by default: the SQL is shown for every answer either way - this adds an extra Run/Cancel click before it executes.")
                }
                row {
                    checkBox("Describe each answer automatically")
                        .bindSelected({ explainAutomaticallyField }, { explainAutomaticallyField = it })
                        .comment("Adds a plain-language description under every result. Uses one extra model call per query; the Explain button always works on demand.")
                }
                row {
                    checkBox("Send sample column values to the model")
                        .bindSelected({ allowDataInPromptField }, { allowDataInPromptField = it })
                        .comment(
                            "Off by default, and the only setting that lets column data reach the model. " +
                                "With it on, the model may also be shown: the keys inside a JSON column, the " +
                                "distinct values of a small low-cardinality column when a query filters on a " +
                                "value that column does not hold, and MongoDB's sampled field values. With it " +
                                "off the model sees the schema only, including a JSON column's key COUNT but " +
                                "not the keys. Query results are never sent either way.",
                        )
                }
                row {
                    checkBox("Answer schema questions in plain language")
                        .bindSelected({ answerSchemaQuestionsField }, { answerSchemaQuestionsField = it })
                        .comment("When a question can't become SQL (\"what is this database for?\", \"how are these tables related?\", \"write me a DELETE for stale rows\"), answer it from the schema instead of erroring - a write request comes back as a statement to run yourself, never executed. Grounded in structure only, never data values; invented names are flagged. Accuracy depends on your model, so treat it as guidance, not fact.")
                }
            }
            group("Business glossary") {
                row {
                    textArea()
                        .bindText({ glossaryField }, { glossaryField = it })
                        .applyToComponent { rows = 4 }
                        .align(Align.FILL)
                        .comment(
                            "One term per line, as <code>term = definition</code>. Use it for words your schema " +
                                "does not define (<code>big order = an order whose total_cents is over 100000</code>) " +
                                "or for a column whose name only hints at its unit " +
                                "(<code>revenue in dollars = sum of orders.total_cents divided by 100</code>). " +
                                "Definitions go to the model with the schema.",
                        )
                }
            }
            group("Custom instructions") {
                row {
                    textArea()
                        .bindText({ customInstructionsField }, { customInstructionsField = it })
                        .applyToComponent { rows = 4 }
                        .align(Align.FILL)
                        .comment(
                            "Appended to AskSQL's system prompt for every question (e.g. house style, " +
                                "preferred date formats, business terminology). The read-only SQL guard " +
                                "still applies no matter what this says.",
                        )
                }
            }
            row {
                button("Reset All Settings to Defaults") { resetToDefaults(modelComboBox) }
                    .comment("Clears provider, model, base URL, engine defaults, and custom instructions on this screen. Does not remove saved connections or stored API keys/passwords - use Remove Connection / Set Database Password for those.")
            }
        }
        dialogPanel = built
        return built
    }

    private fun resetToDefaults(modelComboBox: com.intellij.openapi.ui.ComboBox<String>) {
        val confirmed = Messages.showYesNoDialog(
            "Reset provider, model, base URL, and engine defaults to their built-in values?",
            "Reset AskSQL Settings",
            Messages.getQuestionIcon(),
        ) == Messages.YES
        if (!confirmed) return
        providerField = null
        modelField = defaults.model
        baseUrlField = defaults.baseUrl.orEmpty()
        maxRowsField = defaults.maxRows
        maxSchemaTokensField = defaults.maxSchemaTokens
        requireApprovalField = defaults.requireApproval
        explainAutomaticallyField = defaults.explainAutomatically
        allowDataInPromptField = defaults.allowDataInPrompt
        answerSchemaQuestionsField = defaults.answerSchemaQuestions
        customInstructionsField = defaults.customInstructions
        glossaryField = defaults.glossary
        modelComboBox.removeAllItems()
        dialogPanel?.reset() // re-reads the (now-defaulted) backing fields into every bound Swing component
        forcePersistOnNextApply = true
    }

    /** Makes a real model call: a wrong key, model id, or base URL only fails once a request is sent. */
    private fun testProvider(
        providerComboBox: com.intellij.openapi.ui.ComboBox<ProviderKind>,
        baseUrlTextField: javax.swing.JTextField,
        modelComboBox: com.intellij.openapi.ui.ComboBox<String>,
    ) {
        val provider = providerComboBox.selectedItem as? ProviderKind ?: run {
            Messages.showWarningDialog("Choose a provider first.", "AskSQL")
            return
        }
        val model = (modelComboBox.editor.item as? String)?.trim().orEmpty()
        if (model.isEmpty()) {
            Messages.showWarningDialog("Enter a model name first, or click Fetch Models.", "AskSQL")
            return
        }
        try {
            runBlockingWithProgress(null, "Testing provider") {
                val config = ProviderConfig(
                    provider = provider,
                    model = model,
                    apiKey = String(apiKeyComponent.password).ifEmpty { AskSqlSecrets.getApiKey(provider.wireName) },
                    baseUrl = baseUrlTextField.text.trim().ifEmpty { null },
                )
                LlmClients.forConfig(config).chat("You are a test.", "Reply with the single word OK.")
            }
        } catch (e: Exception) {
            Messages.showErrorDialog(ErrorPresenter.present(e).userMessage, "AskSQL")
            return
        }
        Messages.showInfoMessage("$model responded successfully.", "AskSQL")
    }

    private fun fetchModelsInto(
        providerComboBox: com.intellij.openapi.ui.ComboBox<ProviderKind>,
        baseUrlTextField: javax.swing.JTextField,
        modelComboBox: com.intellij.openapi.ui.ComboBox<String>,
    ) {
        val provider = providerComboBox.selectedItem as? ProviderKind ?: run {
            Messages.showWarningDialog("Choose a provider first.", "AskSQL")
            return
        }
        // Only what is typed here can be read outside a coroutine; a key already in the keychain is
        // resolved inside the fetch below, so an empty field alone is not proof there is no key.
        val typedKey = String(apiKeyComponent.password)
        val storedKey = runBlockingWithProgress(null, "Checking credentials") { AskSqlSecrets.getApiKey(provider.wireName) }
        val key = typedKey.ifEmpty { storedKey }
        // Only the genuinely hosted services need credentials: Ollama and LM Studio are local, and an
        // openai-compatible gateway is whatever the user points it at, which often takes no key at all.
        if (key.isNullOrEmpty() && provider in LlmClients.HOSTED) {
            Messages.showWarningDialog(
                "${provider.wireName} needs an API key before it can list its models. Enter it in the API key " +
                    "field above, then click Fetch Models again.",
                "AskSQL",
            )
            return
        }
        val models = try {
            runBlockingWithProgress(null, "Fetching models") {
                val config = ProviderConfig(
                    provider = provider,
                    model = "",
                    apiKey = String(apiKeyComponent.password).ifEmpty { AskSqlSecrets.getApiKey(provider.wireName) },
                    baseUrl = baseUrlTextField.text.trim().ifEmpty { null },
                )
                LlmClients.forConfig(config).listModels()
            }
        } catch (e: Exception) {
            Messages.showErrorDialog("Could not fetch models: ${ErrorPresenter.present(e).userMessage}", "AskSQL")
            return
        }
        if (models.isEmpty()) {
            Messages.showWarningDialog(
                "${provider.wireName} answered, but offered no model that can hold a conversation. Speech, " +
                    "embedding and classifier models are left out because they reject a question.",
                "AskSQL",
            )
            return
        }
        modelComboBox.removeAllItems()
        models.forEach { modelComboBox.addItem(it) }
        if (modelField in models) modelComboBox.selectedItem = modelField
    }

    // Adds two cases the DSL binding graph can't see: forcePersistOnNextApply, and the unbound API key field.
    override fun isModified(): Boolean =
        forcePersistOnNextApply || (dialogPanel?.isModified() ?: false) || apiKeyComponent.password.isNotEmpty()

    /** A base URL that resolves to this machine; see LlmClients.HOSTED for why that combination is refused. */
    private fun isLoopbackUrl(url: String): Boolean = try {
        java.net.URI.create(url.trim()).host?.let {
            com.rahulmahadik.asksql.ide.llm.BaseUrlGuard.isLoopbackHost(it)
        } == true
    } catch (e: Exception) {
        false // an unparseable URL is rejected by assertBaseUrl instead
    }

    override fun reset() {
        dialogPanel?.reset()
    }

    override fun apply() {
        dialogPanel?.apply()
        val apiKey = String(apiKeyComponent.password)
        if (apiKey.isNotEmpty() && providerField == null) {
            throw ConfigurationException("Choose a provider before saving an API key.")
        }
        baseUrlField.trim().takeIf { it.isNotEmpty() }?.let { url ->
            if (providerField in LlmClients.HOSTED && isLoopbackUrl(url)) {
                throw ConfigurationException(
                    // The URL itself is never echoed: a gateway URL can embed credentials.
                    "${providerField?.wireName} is a hosted service, but the Base URL points at this machine. " +
                        "Clear it, or choose Ollama or LM Studio for a local server.",
                )
            }
            try {
                com.rahulmahadik.asksql.ide.llm.BaseUrlGuard.assertBaseUrl(url, carriesSecret = apiKey.isNotEmpty())
            } catch (e: com.rahulmahadik.asksql.ide.errors.AskSqlException) {
                throw ConfigurationException(e.userMessage)
            }
        }
        settings.provider = providerField?.name.orEmpty()
        settings.model = modelField.trim()
        settings.baseUrl = baseUrlField.trim().ifEmpty { null }
        settings.maxRows = maxRowsField
        settings.maxSchemaTokens = maxSchemaTokensField
        settings.requireApproval = requireApprovalField
        settings.explainAutomatically = explainAutomaticallyField
        settings.allowDataInPrompt = allowDataInPromptField
        settings.answerSchemaQuestions = answerSchemaQuestionsField
        settings.customInstructions = customInstructionsField
        settings.glossary = glossaryField.trim()
        if (apiKey.isNotEmpty()) {
            runBlockingWithProgress(null, "Saving API key") {
                AskSqlSecrets.setApiKey(providerField!!.wireName, apiKey)
            }
            apiKeyComponent.text = ""
        }
        forcePersistOnNextApply = false
        // Refreshes an already-open Chat tab's provider/model label and onboarding state.
        ApplicationManager.getApplication().messageBus.syncPublisher(AskSqlSettingsListener.TOPIC).settingsChanged()
    }
}
