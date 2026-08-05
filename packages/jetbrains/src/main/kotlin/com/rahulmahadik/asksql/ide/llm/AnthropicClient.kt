package com.rahulmahadik.asksql.ide.llm

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration

/** Anthropic Messages API client (streaming via `alt`-free native SSE). */
internal class AnthropicClient(
    private val config: ProviderConfig,
    private val http: HttpClient,
) : LlmClient {

    private val baseUrl = LlmClients.effectiveBaseUrl(config).trimEnd('/')
    private val apiKey = config.apiKey ?: throw AskSqlException(
        AskSqlErrorCode.CONFIG_ERROR,
        userMessage = "Anthropic needs an API key. Set it in AskSQL settings.",
    )

    init {
        BaseUrlGuard.assertBaseUrl(baseUrl, carriesSecret = true)
    }

    private companion object {
        const val ANTHROPIC_VERSION = "2023-06-01"
        const val MAX_TOKENS = 8192
    }

    override suspend fun chat(system: String, userPrompt: String, onToken: TokenListener?): LlmResult {
        val body = JsonObject().apply {
            addProperty("model", config.model)
            addProperty("system", system)
            addProperty("max_tokens", MAX_TOKENS)
            addProperty("stream", true)
            addProperty("temperature", LlmClients.TEMPERATURE)
            add("messages", JsonArray().apply {
                add(JsonObject().apply { addProperty("role", "user"); addProperty("content", userPrompt) })
            })
        }

        val request = HttpRequest.newBuilder(URI.create("$baseUrl/v1/messages"))
            .timeout(Duration.ofSeconds(120))
            .header("Content-Type", "application/json")
            .header("x-api-key", apiKey)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
            .build()

        val reader = LlmClients.openCancellableSseStream(http, request, AskSqlErrorCode.LLM_AUTH)
        val textBuilder = StringBuilder()
        var inputTokens = 0
        var outputTokens = 0
        val coroutineContext = currentCoroutineContext()

        // The blocking read loop, not just the connect, runs off the caller's dispatcher.
        LlmClients.onIo {
            reader.use { r ->
                SseReader(r).forEachDataLine { payload ->
                    coroutineContext.ensureActive()
                    val json = try { JsonParser.parseString(payload).asJsonObject } catch (e: Exception) { return@forEachDataLine true }
                    when (json.get("type")?.asString) {
                        "content_block_delta" -> {
                            val delta = json.getAsJsonObject("delta")
                            if (delta?.get("type")?.asString == "text_delta") {
                                val text = delta.get("text")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
                                textBuilder.append(text)
                                onToken?.onToken(text)
                            }
                        }
                        "message_start" -> {
                            json.getAsJsonObject("message")?.getAsJsonObject("usage")?.let {
                                inputTokens = it.get("input_tokens")?.takeIf { t -> !t.isJsonNull }?.asInt ?: inputTokens
                            }
                        }
                        "message_delta" -> {
                            json.getAsJsonObject("usage")?.let {
                                outputTokens = it.get("output_tokens")?.takeIf { t -> !t.isJsonNull }?.asInt ?: outputTokens
                            }
                        }
                        "error" -> {
                            val message = json.getAsJsonObject("error")?.get("message")?.asString ?: "Anthropic returned an error"
                            val code = if (LlmClients.isContextOverflowMessage(message)) AskSqlErrorCode.LLM_CONTEXT_OVERFLOW else AskSqlErrorCode.LLM_UNAVAILABLE
                            throw AskSqlException(code, detail = message)
                        }
                    }
                    true
                }
            }
        }

        if (textBuilder.isEmpty()) {
            throw AskSqlException(AskSqlErrorCode.LLM_BAD_OUTPUT, detail = "empty streamed response from Anthropic")
        }
        return LlmResult(textBuilder.toString(), LlmUsage(inputTokens, outputTokens))
    }

    override suspend fun listModels(): List<String> = LlmClients.onIo {
        val request = HttpRequest.newBuilder(URI.create("$baseUrl/v1/models"))
            .timeout(Duration.ofSeconds(10))
            .header("x-api-key", apiKey)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .GET()
            .build()
        val response = try {
            http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        } catch (e: java.io.IOException) {
            throw AskSqlException(AskSqlErrorCode.LLM_UNAVAILABLE, detail = e.message, cause = e)
        }
        if (response.statusCode() >= 400) return@onIo emptyList()
        val json = JsonParser.parseString(response.body()).asJsonObject
        json.getAsJsonArray("data")?.mapNotNull { it.asJsonObject?.get("id")?.asString } ?: emptyList()
    }
}
