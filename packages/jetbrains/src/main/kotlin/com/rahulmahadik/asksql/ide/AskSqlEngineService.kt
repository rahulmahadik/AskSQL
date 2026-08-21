package com.rahulmahadik.asksql.ide

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.MongoClientRegistry
import com.rahulmahadik.asksql.ide.engine.EnginePipeline
import com.rahulmahadik.asksql.ide.engine.MongoEnginePipeline
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.llm.LlmClient
import com.rahulmahadik.asksql.ide.llm.LlmClients
import com.rahulmahadik.asksql.ide.llm.ProviderConfig
import com.rahulmahadik.asksql.ide.llm.ProviderKind
import com.rahulmahadik.asksql.ide.model.GuardPolicy
import com.rahulmahadik.asksql.ide.model.MongoGuardPolicy
import com.rahulmahadik.asksql.ide.settings.AskSqlAppSettings
import com.rahulmahadik.asksql.ide.settings.AskSqlSecrets
import kotlinx.coroutines.CoroutineScope

/**
 * Project-level composition root. The [LlmClient] is rebuilt from settings/secrets on every call,
 * so settings changes apply on the next question with no reload step.
 */
@Service(Service.Level.PROJECT)
class AskSqlEngineService(private val project: Project, private val scope: CoroutineScope) {

    companion object {
        fun getInstance(project: Project): AskSqlEngineService = project.service()
    }

    /** A project-lifecycle-bound scope for one-shot background work (onboarding actions, file uploads). */
    val projectScope: CoroutineScope get() = scope

    private val pipelineInstance: EnginePipeline by lazy {
        EnginePipeline(connectionRegistry = project.service<ConnectionRegistry>(), policy = currentGuardPolicy())
    }

    private val mongoPipelineInstance: MongoEnginePipeline by lazy {
        MongoEnginePipeline(clientRegistry = project.service<MongoClientRegistry>(), policy = currentMongoGuardPolicy())
    }

    // The pipeline is a long-lived singleton; its policy and token budget are re-read from settings on every access.
    val pipeline: EnginePipeline get() = pipelineInstance.also {
        it.policy = currentGuardPolicy()
        it.maxSchemaTokens = currentSchemaTokenBudget()
        it.allowDataInPrompt = AskSqlAppSettings.getInstance().allowDataInPrompt
    }
    val mongoPipeline: MongoEnginePipeline get() = mongoPipelineInstance.also {
        it.policy = currentMongoGuardPolicy()
        it.maxSchemaTokens = currentSchemaTokenBudget()
        it.allowDataInPrompt = AskSqlAppSettings.getInstance().allowDataInPrompt
    }

    /** Clamps the configured schema-token budget; the ceiling catches a typo, not a large schema. */
    fun currentSchemaTokenBudget(): Int = AskSqlAppSettings.getInstance().maxSchemaTokens.coerceIn(1000, 200_000)

    fun currentGuardPolicy(): GuardPolicy {
        val settings = AskSqlAppSettings.getInstance()
        return GuardPolicy(maxRows = settings.maxRows.coerceIn(1, 100_000))
    }

    fun currentMongoGuardPolicy(): MongoGuardPolicy {
        val settings = AskSqlAppSettings.getInstance()
        return MongoGuardPolicy(maxRows = settings.maxRows.coerceIn(1, 100_000))
    }

    suspend fun currentLlmClient(): LlmClient {
        val settings = AskSqlAppSettings.getInstance()
        val provider = settings.provider.takeIf { it.isNotBlank() }?.let {
            runCatching { ProviderKind.valueOf(it) }.getOrNull()
        } ?: throw AskSqlException(
            AskSqlErrorCode.CONFIG_ERROR,
            userMessage = "No AI model is configured yet. Open AskSQL settings to choose a provider.",
        )
        if (settings.model.isBlank()) {
            throw AskSqlException(AskSqlErrorCode.CONFIG_ERROR, userMessage = "No model is selected. Open AskSQL settings to pick one.")
        }
        val apiKey = AskSqlSecrets.getApiKey(provider.wireName)
        val config = ProviderConfig(provider = provider, model = settings.model, apiKey = apiKey, baseUrl = settings.baseUrl)
        return LlmClients.forConfig(config)
    }
}
