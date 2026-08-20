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
import java.net.URI
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

    /**
     * A reasoning model narrates before it answers. Stripped at the boundary because every consumer
     * wants the answer and none wants the monologue; Explain and the schema answers never pass through
     * Extract, so cleaning it there alone still showed it.
     */
    private val THINK_BLOCK = Regex("""<(think|thinking|reasoning)>[\s\S]*?</\1>""", RegexOption.IGNORE_CASE)
    // Anchored to the start, because that is where a reasoning model opens. Unanchored, a tag appearing
    // inside the answer truncated it: `WHERE body LIKE '%<think>%'` became an unterminated literal.
    private val THINK_UNCLOSED =
        Regex("""^\s*<(?:think|thinking|reasoning)>[\s\S]*$""", RegexOption.IGNORE_CASE)

    fun withoutReasoning(text: String): String =
        THINK_UNCLOSED.replace(THINK_BLOCK.replace(text, " "), " ").trim()

    /**
     * Listed beside chat models but rejected by /chat/completions. Groq is why speech, TTS and classifier
     * models are here: of its 13 entries only 7 can chat, and the list is alphabetical, so a broken one
     * sits at position 2, where the user picks. `\bguard\b` rather than `guard`, because
     * gpt-oss-safeguard DOES chat.
     * Mirrors isNotChatModel in packages/browser-extension/src/listModels.ts and packages/vscode/src/models.ts.
     */
    private val NON_CHAT_MODEL = Regex(
        """embed|rerank|retriever|[-/]parse$|\bocr\b|whisper|\btts\b|speech|transcribe|orpheus|\bguard\b|moderation""",
        RegexOption.IGNORE_CASE,
    )

    fun isNonChatModel(name: String): Boolean = NON_CHAT_MODEL.containsMatchIn(name)

    /**
     * What the provider itself said, from the OpenAI-shaped `{"error":{"message":...}}` body most of them
     * return. Its own wording ("Invalid API Key", "model_not_found") tells the user far more than a status
     * code does, so it is never discarded.
     */
    fun providerMessage(body: String?): String? {
        if (body.isNullOrBlank()) return null
        return try {
            val root = com.google.gson.JsonParser.parseString(body)
            if (!root.isJsonObject) return null
            val obj = root.asJsonObject
            val error = obj.get("error")
            val message = when {
                error != null && error.isJsonObject -> error.asJsonObject.get("message")
                error != null && error.isJsonPrimitive -> error
                else -> obj.get("message")
            }
            message?.takeIf { !it.isJsonNull }?.asString?.trim()?.takeIf { it.isNotEmpty() }
        } catch (e: Exception) {
            null // a non-JSON body simply has nothing quotable in it
        }
    }

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
    /**
     * Providers that run on someone else's machine: a loopback override cannot be one, and each needs
     * credentials. Ollama, LM Studio and an openai-compatible gateway are absent on purpose.
     */
    val HOSTED = setOf(
        ProviderKind.OPENAI, ProviderKind.GROQ, ProviderKind.NVIDIA, ProviderKind.ANTHROPIC, ProviderKind.GOOGLE,
    )

    fun effectiveBaseUrl(config: ProviderConfig): String {
        // A base URL left behind by a local provider sent hosted traffic to localhost, with no key,
        // and reported success.
        val override = config.baseUrl
        if (override != null && config.provider in HOSTED) {
            val host = runCatching { URI.create(override).host }.getOrNull()
            if (host != null && BaseUrlGuard.isLoopbackHost(host)) {
                throw AskSqlException(
                    AskSqlErrorCode.CONFIG_ERROR,
                    // Never echo the URL: a gateway URL can embed credentials.
                    userMessage = "${config.provider.wireName} is a hosted service, but the Base URL override in " +
                        "AskSQL settings points at this machine. Clear it to reach ${config.provider.wireName}, " +
                        "or pick Ollama or LM Studio if you meant the local server.",
                )
            }
        }
        return override ?: defaultBaseUrl(config.provider)
    }

    private fun defaultBaseUrl(provider: ProviderKind): String = when (provider) {
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
                    val said = providerMessage(body)
                    throw AskSqlException(
                        AskSqlErrorCode.CONFIG_ERROR,
                        userMessage = (if (said.isNullOrBlank()) "The AI provider has no chat model with that name." else said) +
                            " It may be a retired model, a non-chat model, or one your API key has no access to - " +
                            "click Fetch Models in Settings and pick from the list " +
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
                val said = providerMessage(body)
                throw AskSqlException(
                    code,
                    userMessage = if (said.isNullOrBlank()) {
                        AskSqlException.defaultUserMessage(code)
                    } else {
                        "${AskSqlException.defaultUserMessage(code)} The provider said: $said"
                    },
                    detail = "HTTP ${response.statusCode()}: ${body.take(500)}",
                )
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
