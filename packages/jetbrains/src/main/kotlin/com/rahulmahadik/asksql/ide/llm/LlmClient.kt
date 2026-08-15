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

/** A single chat-completion call with streaming tokens; thin adapters over each provider's HTTP wire format. */
interface LlmClient {
    suspend fun chat(system: String, userPrompt: String, onToken: TokenListener? = null): LlmResult
    suspend fun listModels(): List<String>
}

object LlmClients {

    /** Greedy decoding for every provider, matching core's `buildLlmRequestOptions`. */
    const val TEMPERATURE = 0.0

    /** OpenAI o-series and GPT-5 fix temperature internally and reject it being set. */
    private val REASONING_MODEL_RE = Regex("""(?:^|[/:])(o[1-9](?:$|[-.\d])|gpt-5)""", RegexOption.IGNORE_CASE)

    /** A provider rejecting the request specifically because the model fixes temperature internally. */
    private val UNSUPPORTED_TEMPERATURE_RE = Regex(
        """(?:unsupported|not support(?:ed)?|does not support)[^.]{0,60}temperature|temperature[^.]{0,60}(?:unsupported|not support(?:ed)?)""",
        RegexOption.IGNORE_CASE,
    )

    fun isUnsupportedTemperatureError(e: Throwable): Boolean {
        val detail = (e as? com.rahulmahadik.asksql.ide.errors.AskSqlException)?.detail.orEmpty()
        return UNSUPPORTED_TEMPERATURE_RE.containsMatchIn(e.message.orEmpty() + " " + detail)
    }

    fun acceptsTemperature(modelId: String?): Boolean {
        if (modelId.isNullOrBlank()) return true
        return !(REASONING_MODEL_RE.containsMatchIn(modelId) && !modelId.contains("chat", ignoreCase = true))
    }


    private val CONTEXT_OVERFLOW_RE = Regex("""context|token|length|maximum|too long|exceeds""", RegexOption.IGNORE_CASE)

    /** Same classification as core's `classifyLlmError`: a 400/413 whose body talks about context/token/length is a context-overflow, not a generic outage. */
    fun isContextOverflowMessage(message: String): Boolean = CONTEXT_OVERFLOW_RE.containsMatchIn(message)

    /** Wordings that always mean the account itself is out of credit. */
    private val BILLING_ALWAYS_RE = Regex(
        """insufficient_quota|credit balance is too low|out of credits|billing""",
        RegexOption.IGNORE_CASE,
    )

    /** Quota wordings vendors also use for transient window caps; billing only without a retry hint. */
    private val BILLING_QUOTA_RE = Regex("""exceeded your current quota|quota exceeded""", RegexOption.IGNORE_CASE)
    private val RETRY_HINT_RE = Regex("""retrydelay|retryinfo|try again in""", RegexOption.IGNORE_CASE)

    /**
     * An exhausted account, as opposed to a per-minute cap: no amount of waiting clears it. Mirrors
     * isBillingExhaustion in packages/core/src/llm.ts - without the retry-hint exclusion, Gemini's
     * per-minute 429 ("exceeded your current quota" plus retryDelay) was reported as a dead account.
     */
    fun isBillingExhaustionMessage(body: String): Boolean {
        if (BILLING_ALWAYS_RE.containsMatchIn(body)) return true
        if (!BILLING_QUOTA_RE.containsMatchIn(body)) return false
        // A granted limit of zero means no allocation at all - waiting never helps.
        if (Regex("""limit:\s*0\b""", RegexOption.IGNORE_CASE).containsMatchIn(body)) return true
        return !RETRY_HINT_RE.containsMatchIn(body)
    }

    /** A shared [HttpClient] wired to the platform's proxy selector, so provider calls honor the IDE's HTTP/SOCKS proxy. */
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

    /** Bounds a full `chat()` call, streamed response included. Uses [withHardTimeout] (a real `Future.get`), not `kotlinx.coroutines.withTimeout`, which test virtual clocks fast-forward. */
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
     * closes the HTTP stream. Non-2xx becomes [AskSqlException] immediately.
     */
    suspend fun openCancellableSseStream(httpClient: HttpClient, request: HttpRequest, authErrorCode: AskSqlErrorCode): BufferedReader {
        // Captured before the withContext hop in onIo{}: the close-on-cancel hook goes on the caller's
        // own job (what Stop cancels), not that hop's short-lived child.
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
                    throw AskSqlException(
                        AskSqlErrorCode.CONFIG_ERROR,
                        userMessage = "The AI provider has no chat model with that name. It may be an embedding or reranking model, " +
                            "or one your API key has no access to - pick a different model in Settings " +
                            "(for Ollama, pull it first with `ollama pull <model>`).",
                        detail = "HTTP 404: ${body.take(500)}",
                    )
                }
                val status = response.statusCode()
                val code = when {
                    (status == 400 || status == 413) && isContextOverflowMessage(body) -> AskSqlErrorCode.LLM_CONTEXT_OVERFLOW
                    isBillingExhaustionMessage(body) -> AskSqlErrorCode.LLM_BILLING
                    status == 429 -> AskSqlErrorCode.LLM_RATE_LIMIT
                    else -> AskSqlErrorCode.LLM_UNAVAILABLE
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
