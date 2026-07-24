package com.rahulmahadik.asksql.ide.llm

/**
 * The VS Code extension's provider set plus named presets (LM_STUDIO, NVIDIA) for settings-UI
 * discoverability; the presets add only a friendly name and default base URL over OPENAI_COMPATIBLE.
 */
enum class ProviderKind {
    OPENAI, ANTHROPIC, GOOGLE, GROQ, OLLAMA, OPENAI_COMPATIBLE, LM_STUDIO, NVIDIA;

    val wireName: String get() = name.lowercase().replace('_', '-')
}

data class ProviderConfig(
    val provider: ProviderKind,
    val model: String,
    val apiKey: String? = null,
    val baseUrl: String? = null,
)

data class LlmUsage(val inputTokens: Int = 0, val outputTokens: Int = 0)

data class LlmResult(val text: String, val usage: LlmUsage)

fun interface TokenListener {
    fun onToken(text: String)
}

object DefaultEndpoints {
    const val OLLAMA_BASE_URL = "http://localhost:11434/v1"
    const val LM_STUDIO_BASE_URL = "http://localhost:1234/v1"
    const val ANTHROPIC_BASE_URL = "https://api.anthropic.com"
    const val GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com"
    const val OPENAI_BASE_URL = "https://api.openai.com/v1"
    const val GROQ_BASE_URL = "https://api.groq.com/openai/v1"
    const val NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
}
