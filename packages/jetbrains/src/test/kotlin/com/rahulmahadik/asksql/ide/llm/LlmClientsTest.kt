package com.rahulmahadik.asksql.ide.llm

import com.rahulmahadik.asksql.ide.errors.AskSqlException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Provider-routing tests: every [ProviderKind] must resolve to a documented
 * default base URL (or a clear config error, for the one provider that has
 * none) and to the correct wire-protocol [LlmClient] implementation.
 */
class LlmClientsTest {

    @Test fun `each named provider resolves its documented default base URL`() {
        assertEquals(DefaultEndpoints.OPENAI_BASE_URL, LlmClients.effectiveBaseUrl(config(ProviderKind.OPENAI)))
        assertEquals(DefaultEndpoints.GROQ_BASE_URL, LlmClients.effectiveBaseUrl(config(ProviderKind.GROQ)))
        assertEquals(DefaultEndpoints.OLLAMA_BASE_URL, LlmClients.effectiveBaseUrl(config(ProviderKind.OLLAMA)))
        assertEquals(DefaultEndpoints.LM_STUDIO_BASE_URL, LlmClients.effectiveBaseUrl(config(ProviderKind.LM_STUDIO)))
        assertEquals(DefaultEndpoints.NVIDIA_BASE_URL, LlmClients.effectiveBaseUrl(config(ProviderKind.NVIDIA)))
        assertEquals(DefaultEndpoints.ANTHROPIC_BASE_URL, LlmClients.effectiveBaseUrl(config(ProviderKind.ANTHROPIC)))
        assertEquals(DefaultEndpoints.GOOGLE_BASE_URL, LlmClients.effectiveBaseUrl(config(ProviderKind.GOOGLE)))
    }

    /**
     * Groq's real catalogue as of 2026-08-19. Six of
     * the thirteen reject a chat request, and the list is alphabetical, so two broken ones sat at
     * positions 2 and 3 - where a user picks. Models listed fine; the query then failed.
     */
    @Test fun `only the Groq models that can answer a query are offered`() {
        val listed = listOf(
            "allam-2-7b",
            "canopylabs/orpheus-arabic-saudi",
            "canopylabs/orpheus-v1-english",
            "groq/compound",
            "groq/compound-mini",
            "meta-llama/llama-prompt-guard-2-22m",
            "meta-llama/llama-prompt-guard-2-86m",
            "openai/gpt-oss-120b",
            "openai/gpt-oss-20b",
            "openai/gpt-oss-safeguard-20b",
            "qwen/qwen3.6-27b",
            "whisper-large-v3",
            "whisper-large-v3-turbo",
        )
        assertEquals(
            listOf(
                "allam-2-7b",
                "groq/compound",
                "groq/compound-mini",
                "openai/gpt-oss-120b",
                "openai/gpt-oss-20b",
                "openai/gpt-oss-safeguard-20b",
                "qwen/qwen3.6-27b",
            ),
            listed.filterNot { LlmClients.isNonChatModel(it) },
        )
    }

    @Test fun `a chatting model is not filtered just for carrying the word safeguard`() {
        assertFalse(LlmClients.isNonChatModel("openai/gpt-oss-safeguard-20b"))
        assertTrue(LlmClients.isNonChatModel("meta-llama/llama-prompt-guard-2-22m"))
    }

    @Test fun `the provider's own words are lifted out of an error body`() {
        assertEquals("Invalid API Key", LlmClients.providerMessage("""{"error":{"message":"Invalid API Key","code":"invalid_api_key"}}"""))
        assertEquals("plain", LlmClients.providerMessage("""{"message":"plain"}"""))
        assertEquals(null, LlmClients.providerMessage("not json at all"))
        assertEquals(null, LlmClients.providerMessage(""))
    }

    /**
     * Reported from a real install: the user had been on Ollama, switched the provider to Groq, entered no
     * key, and Test Provider reported success. The stale base URL meant the request never left the machine.
     */
    @Test fun `a hosted provider refuses a base URL pointing at this machine`() {
        for (url in listOf("http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1")) {
            val e = assertThrows(AskSqlException::class.java) {
                LlmClients.effectiveBaseUrl(ProviderConfig(ProviderKind.GROQ, "m", apiKey = null, baseUrl = url))
            }
            assertTrue(e.userMessage, e.userMessage.contains("this machine"))
        }
    }

    @Test fun `a local provider still accepts its own loopback endpoint`() {
        assertEquals(
            "http://localhost:11434/v1",
            LlmClients.effectiveBaseUrl(ProviderConfig(ProviderKind.OLLAMA, "m", baseUrl = "http://localhost:11434/v1")),
        )
    }

    @Test fun `a hosted provider still accepts a real remote gateway`() {
        assertEquals(
            "https://gateway.example.com/v1",
            LlmClients.effectiveBaseUrl(ProviderConfig(ProviderKind.GROQ, "m", baseUrl = "https://gateway.example.com/v1")),
        )
    }

    @Test fun `only the hosted services are treated as needing a key`() {
        // Ollama and LM Studio are local; an openai-compatible gateway is whatever the user points it at,
        // and a self-hosted vLLM or LiteLLM commonly takes no key. Demanding one there blocks a valid setup.
        for (local in listOf(ProviderKind.OLLAMA, ProviderKind.LM_STUDIO, ProviderKind.OPENAI_COMPATIBLE)) {
            assertFalse(local.name, local in LlmClients.HOSTED)
        }
        for (hosted in listOf(ProviderKind.OPENAI, ProviderKind.GROQ, ProviderKind.NVIDIA, ProviderKind.ANTHROPIC, ProviderKind.GOOGLE)) {
            assertTrue(hosted.name, hosted in LlmClients.HOSTED)
        }
    }

    @Test fun `NVIDIA default base URL is the NIM OpenAI-compatible endpoint`() {
        assertEquals("https://integrate.api.nvidia.com/v1", DefaultEndpoints.NVIDIA_BASE_URL)
    }

    @Test fun `an explicit base URL override always wins over the provider default`() {
        val overridden = config(ProviderKind.NVIDIA).copy(baseUrl = "https://my-gateway.example.com/v1")
        assertEquals("https://my-gateway.example.com/v1", LlmClients.effectiveBaseUrl(overridden))
    }

    @Test fun `OPENAI_COMPATIBLE has no default and requires an explicit base URL`() {
        val error = assertThrows(AskSqlException::class.java) {
            LlmClients.effectiveBaseUrl(config(ProviderKind.OPENAI_COMPATIBLE))
        }
        assertTrue(error.userMessage.contains("base URL"))
    }

    @Test fun `NVIDIA routes through the OpenAI-compatible wire client`() {
        assertTrue(LlmClients.forConfig(config(ProviderKind.NVIDIA)) is OpenAiCompatibleClient)
    }

    @Test fun `ANTHROPIC and GOOGLE route through their own dedicated clients, not OpenAI-compatible`() {
        assertTrue(LlmClients.forConfig(config(ProviderKind.ANTHROPIC)) is AnthropicClient)
        assertTrue(LlmClients.forConfig(config(ProviderKind.GOOGLE)) is GeminiClient)
    }

    @Test fun `wireName is lowercase with hyphens, used as the PasswordSafe key`() {
        assertEquals("nvidia", ProviderKind.NVIDIA.wireName)
        assertEquals("lm-studio", ProviderKind.LM_STUDIO.wireName)
        assertEquals("openai-compatible", ProviderKind.OPENAI_COMPATIBLE.wireName)
    }

    @Test fun `context-overflow error bodies are recognized regardless of provider wording`() {
        assertTrue(LlmClients.isContextOverflowMessage("This model's maximum context length is 4096 tokens"))
        assertTrue(LlmClients.isContextOverflowMessage("prompt is too long: 12000 tokens > 8000 maximum"))
        assertTrue(LlmClients.isContextOverflowMessage("input length exceeds the model's context window"))
        assertTrue(LlmClients.isContextOverflowMessage("Request exceeds the model's context length"))
    }

    @Test fun `unrelated error bodies are not misclassified as context overflow`() {
        assertEquals(false, LlmClients.isContextOverflowMessage("invalid API key"))
        assertEquals(false, LlmClients.isContextOverflowMessage("internal server error"))
    }

    private fun config(provider: ProviderKind) = ProviderConfig(provider = provider, model = "some-model", apiKey = "test-key")

    /** An exhausted account and a per-minute cap need opposite advice, so they cannot share a message. */
    @Test fun `an exhausted account is told apart from a rate limit`() {
        assertTrue(LlmClients.isBillingExhaustionMessage("""{"error":{"code":"insufficient_quota"}}"""))
        assertTrue(LlmClients.isBillingExhaustionMessage("Your credit balance is too low to access the API"))
        assertTrue(LlmClients.isBillingExhaustionMessage("You exceeded your current quota, please check your plan"))
        assertFalse(LlmClients.isBillingExhaustionMessage("Rate limit reached for gpt-4o, try again in 20s"))
        assertFalse(LlmClients.isBillingExhaustionMessage("service temporarily unavailable"))
    }
}
