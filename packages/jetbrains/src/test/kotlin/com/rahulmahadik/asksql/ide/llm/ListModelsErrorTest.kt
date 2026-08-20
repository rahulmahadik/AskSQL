package com.rahulmahadik.asksql.ide.llm

import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress

/**
 * Fetching models used to answer `emptyList()` for every HTTP failure, so a missing key, a revoked key, a
 * rate limit and an outage all read as "this provider has no models". Groq replies `{"error":{"message":
 * "Invalid API Key"}}` and that sentence was discarded. Reported from a real install as "not connecting".
 */
class ListModelsErrorTest {

    private fun serving(status: Int, body: String, block: (String) -> Unit) {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/v1/models") { ex ->
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            block("http://127.0.0.1:${server.address.port}/v1")
        } finally {
            server.stop(0)
        }
    }

    /** An SSE stream whose content deltas spell out `text`, as a provider would send it. */
    private fun sseFor(text: String): String =
        text.chunked(12).joinToString("") { chunk ->
            "data: {\"choices\":[{\"delta\":{\"content\":${com.google.gson.JsonPrimitive(chunk)}}}]}\n\n"
        } + "data: [DONE]\n\n"

    private fun servingChat(body: String, block: (String) -> Unit) {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/v1/chat/completions") { ex ->
            val bytes = body.toByteArray()
            ex.responseHeaders.add("Content-Type", "text/event-stream")
            ex.sendResponseHeaders(200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            block("http://127.0.0.1:${server.address.port}/v1")
        } finally {
            server.stop(0)
        }
    }

    /**
     * The reader's complaint was about Explain, which returns the model's text verbatim and never passes
     * through Extract. Stripping at the client is what covers it, so the assertion belongs here.
     */
    @Test fun `the client returns an answer with the reasoning already removed`() = runTest {
        val reply = "<think>The user wants a count. Looking at the schema.</think>Counts the clients."
        servingChat(sseFor(reply)) { url ->
            val client = LlmClients.forConfig(ProviderConfig(ProviderKind.OLLAMA, "m", apiKey = null, baseUrl = url))
            val out = kotlinx.coroutines.runBlocking { client.chat("sys", "user") }.text
            assertEquals("Counts the clients.", out)
            assertTrue(out, !out.contains("<think>") && !out.contains("The user wants"))
        }
    }

    private fun clientFor(baseUrl: String) =
        LlmClients.forConfig(ProviderConfig(ProviderKind.OLLAMA, model = "", apiKey = null, baseUrl = baseUrl))

    @Test fun `an invalid key is reported in the provider's own words`() = runTest {
        serving(401, """{"error":{"message":"Invalid API Key","code":"invalid_api_key"}}""") { url ->
            val e = assertThrows(AskSqlException::class.java) { kotlinx.coroutines.runBlocking { clientFor(url).listModels() } }
            assertEquals(AskSqlErrorCode.LLM_AUTH, e.code)
            assertTrue(e.userMessage, e.userMessage.contains("Invalid API Key"))
        }
    }

    @Test fun `a rate limit is not mistaken for an empty catalogue`() = runTest {
        serving(429, """{"error":{"message":"Rate limit reached"}}""") { url ->
            val e = assertThrows(AskSqlException::class.java) { kotlinx.coroutines.runBlocking { clientFor(url).listModels() } }
            assertEquals(AskSqlErrorCode.LLM_RATE_LIMIT, e.code)
            assertTrue(e.userMessage, e.userMessage.contains("Rate limit reached"))
        }
    }

    @Test fun `a body with nothing quotable still names the status`() = runTest {
        serving(500, "<html>gateway error</html>") { url ->
            val e = assertThrows(AskSqlException::class.java) { kotlinx.coroutines.runBlocking { clientFor(url).listModels() } }
            assertEquals(AskSqlErrorCode.LLM_UNAVAILABLE, e.code)
            assertTrue(e.userMessage, e.userMessage.contains("500"))
        }
    }

    @Test fun `a healthy catalogue still lists, minus the models that cannot chat`() = runTest {
        val body = """{"data":[{"id":"qwen/qwen3.6-27b"},{"id":"whisper-large-v3"},{"id":"openai/gpt-oss-20b"}]}"""
        serving(200, body) { url ->
            val models = kotlinx.coroutines.runBlocking { clientFor(url).listModels() }
            assertEquals(listOf("openai/gpt-oss-20b", "qwen/qwen3.6-27b"), models)
        }
    }
}
