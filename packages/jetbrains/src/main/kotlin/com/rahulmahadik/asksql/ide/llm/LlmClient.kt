package com.rahulmahadik.asksql.ide.llm

import com.intellij.util.net.JdkProxyProvider
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.util.withHardTimeout
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.TimeoutException

/** A single chat-completion call with streaming tokens; thin adapters over each provider's HTTP wire format, no provider SDK dependency needed for small JSON payloads. */
interface LlmClient {
    suspend fun chat(system: String, userPrompt: String, onToken: TokenListener? = null): LlmResult
    suspend fun listModels(): List<String>
}

object LlmClients {

    private val CONTEXT_OVERFLOW_RE = Regex("""context|token|length|maximum|too long|exceeds""", RegexOption.IGNORE_CASE)

    /** Same classification as core's `classifyLlmError`: a 400/413 whose body talks about context/token/length is a context-overflow, not a generic outage; [EnginePipeline.ask]/[com.rahulmahadik.asksql.ide.engine.MongoEnginePipeline.ask] shrink the schema and retry on that code. */
    fun isContextOverflowMessage(message: String): Boolean = CONTEXT_OVERFLOW_RE.containsMatchIn(message)

    /** A shared [HttpClient] wired to the platform's proxy selector, so every provider call honors a corporate HTTP/SOCKS proxy like the rest of the IDE. */
    val sharedHttpClient: HttpClient by lazy {
        HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .proxy(JdkProxyProvider.getInstance().proxySelector)
            .build()
    }

    fun forConfig(config: ProviderConfig): LlmClient = when (config.provider) {
        ProviderKind.ANTHROPIC -> AnthropicClient(config, sharedHttpClient)
        ProviderKind.GOOGLE -> GeminiClient(config, sharedHttpClient)
        ProviderKind.OPENAI, ProviderKind.GROQ, ProviderKind.OLLAMA, ProviderKind.LM_STUDIO, ProviderKind.NVIDIA, ProviderKind.OPENAI_COMPATIBLE ->
            OpenAiCompatibleClient(config, sharedHttpClient)
    }

    /** Effective base URL after applying each provider's documented default. */
    fun effectiveBaseUrl(config: ProviderConfig): String = config.baseUrl ?: when (config.provider) {
        ProviderKind.OPENAI -> DefaultEndpoints.OPENAI_BASE_URL
        ProviderKind.GROQ -> DefaultEndpoints.GROQ_BASE_URL
        ProviderKind.OLLAMA -> DefaultEndpoints.OLLAMA_BASE_URL
        ProviderKind.LM_STUDIO -> DefaultEndpoints.LM_STUDIO_BASE_URL
        ProviderKind.NVIDIA -> DefaultEndpoints.NVIDIA_BASE_URL
        ProviderKind.ANTHROPIC -> DefaultEndpoints.ANTHROPIC_BASE_URL
        ProviderKind.GOOGLE -> DefaultEndpoints.GOOGLE_BASE_URL
        ProviderKind.OPENAI_COMPATIBLE -> throw AskSqlException(
            AskSqlErrorCode.CONFIG_ERROR,
            userMessage = "The OpenAI-compatible provider needs a base URL. Set it in AskSQL settings.",
        )
    }

    /** Runs [block] on the IO dispatcher, cooperatively cancellable between chunks via [currentCoroutineContext]. */
    suspend fun <T> onIo(block: suspend () -> T): T = withContext(Dispatchers.IO) {
        ensureActive()
        block()
    }

    private const val CHAT_TIMEOUT_MS = 600_000L

    /** Bounds a full `chat()` call, streamed response included, so a provider that goes silent mid-stream doesn't hang forever. Uses [withHardTimeout] (a real `Future.get`), not `kotlinx.coroutines.withTimeout`, since the latter is dispatcher-bound and gets fast-forwarded by test virtual clocks that don't know about the real blocking HTTP read. */
    suspend fun <T> withChatTimeout(block: suspend () -> T): T =
        try {
            withHardTimeout(CHAT_TIMEOUT_MS) { block() }
        } catch (e: TimeoutException) {
            throw AskSqlException(
                AskSqlErrorCode.LLM_UNAVAILABLE,
                userMessage = "The model stopped responding (no data for ${CHAT_TIMEOUT_MS / 1000}s). Try again.",
                cause = e,
            )
        }

    /**
     * Sends [request] and returns a [BufferedReader] over its body; cancelling the calling coroutine
     * closes the HTTP stream, unblocking the uninterruptible socket read. Non-2xx becomes [AskSqlException] immediately.
     */
    suspend fun openCancellableSseStream(httpClient: HttpClient, request: HttpRequest, authErrorCode: AskSqlErrorCode): BufferedReader {
        // Captured before the withContext hop inside onIo{}: that hop creates a short-lived child
        // job that completes the moment this returns the BufferedReader, so the close-on-cancel
        // hook must go on the caller's own job (what Stop cancels), which stays alive for the
        // whole read loop.
        val callerJob = currentCoroutineContext().job
        return onIo {
            val response: HttpResponse<java.io.InputStream> = try {
                httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream())
            } catch (e: IOException) {
                throw AskSqlException(AskSqlErrorCode.LLM_UNAVAILABLE, detail = e.message, cause = e)
            }
            if (response.statusCode() == 401 || response.statusCode() == 403) {
                // Release the unread body stream, else the connection leaks on auth failure.
                try { response.body().close() } catch (_: IOException) { /* already closing */ }
                throw AskSqlException(authErrorCode, detail = "HTTP ${response.statusCode()}")
            }
            if (response.statusCode() >= 400) {
                val body = response.body().bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
                if (response.statusCode() == 404) {
                    // A 404 from an LLM endpoint means the model name is wrong/not installed, not a down provider.
                    throw AskSqlException(
                        AskSqlErrorCode.CONFIG_ERROR,
                        userMessage = "The AI provider returned 404 - the model name is likely wrong or not installed. Check the model in Settings (for Ollama, pull it first with `ollama pull <model>`).",
                        detail = "HTTP 404: ${body.take(500)}",
                    )
                }
                val code = if ((response.statusCode() == 400 || response.statusCode() == 413) && isContextOverflowMessage(body)) {
                    AskSqlErrorCode.LLM_CONTEXT_OVERFLOW
                } else {
                    AskSqlErrorCode.LLM_UNAVAILABLE
                }
                throw AskSqlException(code, detail = "HTTP ${response.statusCode()}: ${body.take(500)}")
            }
            val stream = response.body()
            callerJob.invokeOnCompletion { cause ->
                if (cause is CancellationException) {
                    try { stream.close() } catch (_: IOException) { /* already closing */ }
                }
            }
            BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8))
        }
    }
}
