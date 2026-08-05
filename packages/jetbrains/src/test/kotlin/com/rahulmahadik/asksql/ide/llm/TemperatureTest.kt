package com.rahulmahadik.asksql.ide.llm

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Greedy decoding, matching core. Without it the plugin sampled at the provider's default, so the
 * same question produced different SQL run to run and the scope guard let questions through that
 * core declined.
 */
class TemperatureTest {

    @Test
    fun `decoding is greedy`() {
        assertTrue(LlmClients.TEMPERATURE == 0.0)
    }

    @Test
    fun `ordinary models take a temperature`() {
        for (model in listOf("qwen2.5-coder:7b", "gpt-4o", "claude-sonnet-4", "gemini-2.5-pro", "llama3.3", "gpt-5-chat-latest")) {
            assertTrue("expected $model to accept temperature", LlmClients.acceptsTemperature(model))
        }
    }

    /** Setting it on a reasoning model is an error from the provider, not a better answer. */
    @Test
    fun `reasoning models are left alone`() {
        for (model in listOf("o1", "o1-preview", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "openai/o3", "azure:o1-preview")) {
            assertFalse("expected $model to reject temperature", LlmClients.acceptsTemperature(model))
        }
    }

    @Test
    fun `an unknown or missing model still gets a temperature`() {
        assertTrue(LlmClients.acceptsTemperature(null))
        assertTrue(LlmClients.acceptsTemperature(""))
        assertTrue(LlmClients.acceptsTemperature("my-company-deployment"))
    }
}
