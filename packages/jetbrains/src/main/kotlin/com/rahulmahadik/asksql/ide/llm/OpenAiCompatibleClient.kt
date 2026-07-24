package com.rahulmahadik.asksql.ide.llm

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration

/**
 * OpenAI-compatible chat-completions protocol: the workhorse client covering OpenAI, Groq, NVIDIA NIM,
 * Azure OpenAI, Ollama and LM Studio (`/v1`), and any BYO gateway (LiteLLM, OpenRouter, ...).
 */
internal class OpenAiCompatibleClient(
    private val config: ProviderConfig,
    private val http: HttpClient,
) : LlmClient {

    private val baseUrl = LlmClients.effectiveBaseUrl(config).trimEnd('/')

    init {
        BaseUrlGuard.assertBaseUrl(baseUrl, carriesSecret = !config.apiKey.isNullOrEmpty())
    }

    override suspend fun chat(system: String, userPrompt: String, onToken: TokenListener?): LlmResult {
        val body = JsonObject().apply {
            addProperty("model", config.model)
            addProperty("stream", true)
            add("messages", com.google.gson.JsonArray().apply {
                add(JsonObject().apply { addProperty("role", "system"); addProperty("content", system) })
                add(JsonObject().apply { addProperty("role", "user"); addProperty("content", userPrompt) })
            })
        }

        val requestBuilder = HttpRequest.newBuilder(URI.create("$baseUrl/chat/completions"))
            .timeout(Duration.ofSeconds(120))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
        config.apiKey?.takeIf { it.isNotEmpty() }?.let { requestBuilder.header("Authorization", "Bearer $it") }

        val reader = LlmClients.openCancellableSseStream(http, requestBuilder.build(), AskSqlErrorCode.LLM_AUTH)
        val textBuilder = StringBuilder()
        var promptTokens = 0
        var completionTokens = 0
        // Captured once here (a suspend call) so the non-suspend SSE callback
        // below can cheaply re-check liveness per line via the plain
        // CoroutineContext.ensureActive() extension.
        val coroutineContext = currentCoroutineContext()

        // The blocking line-by-line read loop needs its own IO hop too (not just opening the
        // connection); otherwise it runs on whatever dispatcher the caller's coroutine is on
        // (Dispatchers.Default for the chat UI), tying up a CPU-sized pool thread.
        LlmClients.onIo {
            reader.use { r ->
                SseReader(r).forEachDataLine { payload ->
                    coroutineContext.ensureActive()
                    val json = try { JsonParser.parseString(payload).asJsonObject } catch (e: Exception) { return@forEachDataLine true }
                    val choices = json.getAsJsonArray("choices")
                    val delta = choices?.firstOrNull()?.asJsonObject?.getAsJsonObject("delta")
                    val content = delta?.get("content")?.takeIf { !it.isJsonNull }?.asString
                    if (!content.isNullOrEmpty()) {
                        textBuilder.append(content)
                        onToken?.onToken(content)
                    }
                    json.getAsJsonObject("usage")?.let { usage ->
                        promptTokens = usage.get("prompt_tokens")?.asInt ?: promptTokens
                        completionTokens = usage.get("completion_tokens")?.asInt ?: completionTokens
                    }
                    true
                }
            }
        }

        if (textBuilder.isEmpty()) {
            throw AskSqlException(AskSqlErrorCode.LLM_BAD_OUTPUT, detail = "empty streamed response from $baseUrl")
        }
        return LlmResult(textBuilder.toString(), LlmUsage(promptTokens, completionTokens))
    }

    override suspend fun listModels(): List<String> = LlmClients.onIo {
        val requestBuilder = HttpRequest.newBuilder(URI.create("$baseUrl/models"))
            .timeout(Duration.ofSeconds(10))
            .GET()
        config.apiKey?.takeIf { it.isNotEmpty() }?.let { requestBuilder.header("Authorization", "Bearer $it") }

        val response = try {
            http.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        } catch (e: java.io.IOException) {
            throw AskSqlException(AskSqlErrorCode.LLM_UNAVAILABLE, detail = e.message, cause = e)
        }
        if (response.statusCode() >= 400) return@onIo emptyList()

        val json = JsonParser.parseString(response.body()).asJsonObject
        val data = json.getAsJsonArray("data") ?: return@onIo emptyList()
        data.mapNotNull { it.asJsonObject?.get("id")?.asString }
            .filterNot { it.contains("embed", ignoreCase = true) }
            .sorted()
    }
}
