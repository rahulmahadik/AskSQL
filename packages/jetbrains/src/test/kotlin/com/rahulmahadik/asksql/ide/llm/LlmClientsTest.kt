package com.rahulmahadik.asksql.ide.llm

import com.rahulmahadik.asksql.ide.errors.AskSqlException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
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
}
