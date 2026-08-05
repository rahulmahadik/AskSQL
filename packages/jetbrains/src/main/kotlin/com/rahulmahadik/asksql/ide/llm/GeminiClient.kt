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

/** Google Gemini `generateContent` client, streamed via `alt=sse`. */
internal class GeminiClient(
    private val config: ProviderConfig,
    private val http: HttpClient,
) : LlmClient {

    private val baseUrl = LlmClients.effectiveBaseUrl(config).trimEnd('/')
    private val apiKey = config.apiKey ?: throw AskSqlException(
        AskSqlErrorCode.CONFIG_ERROR,
        userMessage = "Google Gemini needs an API key. Set it in AskSQL settings.",
    )

    init {
        BaseUrlGuard.assertBaseUrl(baseUrl, carriesSecret = true)
    }

    private fun textPart(text: String) = JsonObject().apply { addProperty("text", text) }

    override suspend fun chat(system: String, userPrompt: String, onToken: TokenListener?): LlmResult {
        val body = JsonObject().apply {
            add("generationConfig", JsonObject().apply { addProperty("temperature", LlmClients.TEMPERATURE) })
            add("systemInstruction", JsonObject().apply { add("parts", JsonArray().apply { add(textPart(system)) }) })
            add("contents", JsonArray().apply {
                add(JsonObject().apply {
                    addProperty("role", "user")
                    add("parts", JsonArray().apply { add(textPart(userPrompt)) })
                })
            })
        }

        // Gemini takes auth in the x-goog-api-key header, not the legacy ?key= query parameter.
        val uri = URI.create("$baseUrl/v1beta/models/${config.model}:streamGenerateContent?alt=sse")
        val request = HttpRequest.newBuilder(uri)
            .timeout(Duration.ofSeconds(120))
            .header("Content-Type", "application/json")
            .header("x-goog-api-key", apiKey)
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
            .build()

        val reader = LlmClients.openCancellableSseStream(http, request, AskSqlErrorCode.LLM_AUTH)
        val textBuilder = StringBuilder()
        var inputTokens = 0
        var outputTokens = 0
        val coroutineContext = currentCoroutineContext()

        // The blocking read loop, not just opening the connection, runs off the caller's dispatcher.
        LlmClients.onIo {
            reader.use { r ->
                SseReader(r).forEachDataLine { payload ->
                    coroutineContext.ensureActive()
                    val json = try { JsonParser.parseString(payload).asJsonObject } catch (e: Exception) { return@forEachDataLine true }
                    json.getAsJsonArray("candidates")?.firstOrNull()?.asJsonObject
                        ?.getAsJsonObject("content")?.getAsJsonArray("parts")
                        ?.mapNotNull { it.asJsonObject?.get("text")?.takeIf { t -> !t.isJsonNull }?.asString }
                        ?.joinToString("")
                        ?.takeIf { it.isNotEmpty() }
                        ?.let { text ->
                            textBuilder.append(text)
                            onToken?.onToken(text)
                        }
                    json.getAsJsonObject("usageMetadata")?.let { usage ->
                        inputTokens = usage.get("promptTokenCount")?.takeIf { !it.isJsonNull }?.asInt ?: inputTokens
                        outputTokens = usage.get("candidatesTokenCount")?.takeIf { !it.isJsonNull }?.asInt ?: outputTokens
                    }
                    true
                }
            }
        }

        if (textBuilder.isEmpty()) {
            throw AskSqlException(AskSqlErrorCode.LLM_BAD_OUTPUT, detail = "empty streamed response from Gemini")
        }
        return LlmResult(textBuilder.toString(), LlmUsage(inputTokens, outputTokens))
    }

    override suspend fun listModels(): List<String> = LlmClients.onIo {
        val request = HttpRequest.newBuilder(URI.create("$baseUrl/v1beta/models"))
            .timeout(Duration.ofSeconds(10))
            .header("x-goog-api-key", apiKey)
            .GET()
            .build()
        val response = try {
            http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        } catch (e: java.io.IOException) {
            throw AskSqlException(AskSqlErrorCode.LLM_UNAVAILABLE, detail = e.message, cause = e)
        }
        if (response.statusCode() >= 400) return@onIo emptyList()
        val json = JsonParser.parseString(response.body()).asJsonObject
        json.getAsJsonArray("models")?.mapNotNull { el ->
            val obj = el.asJsonObject
            val methods = obj.getAsJsonArray("supportedGenerationMethods")?.map { it.asString } ?: emptyList()
            if ("generateContent" in methods) obj.get("name")?.asString?.removePrefix("models/") else null
        } ?: emptyList()
    }
}
