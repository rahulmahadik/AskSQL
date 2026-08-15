package com.rahulmahadik.asksql.ide.llm

import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import java.net.URI
import java.net.URISyntaxException

/** Validates the base URL at settings time. Never interpolate the raw URL into a thrown message: a gateway URL can embed credentials (`https://user:pass@host/v1`); name the setting instead. */
object BaseUrlGuard {

    private val IPV4_MAPPED = Regex("""^::ffff:(\d+\.\d+\.\d+\.\d+)$""", RegexOption.IGNORE_CASE)

    /** Normalizes the inet_aton forms (hex, octal, 1-to-3 parts) to dotted-quad before any range check. */
    internal fun toIpv4OrNull(host: String): String? {
        val parts = host.split('.')
        if (parts.isEmpty() || parts.size > 4) return null
        val values = parts.map { part ->
            if (part.isEmpty()) return null
            val value = when {
                part.startsWith("0x", ignoreCase = true) -> part.drop(2).takeIf { it.isNotEmpty() }?.toLongOrNull(16)
                part.length > 1 && part.startsWith("0") -> part.drop(1).toLongOrNull(8)
                else -> part.toLongOrNull(10)
            }
            if (value == null || value < 0) return null
            value
        }
        // The final part absorbs every byte the earlier parts didn't name.
        val lastMax = when (values.size) { 1 -> 0xFFFFFFFFL; 2 -> 0xFFFFFFL; 3 -> 0xFFFFL; else -> 0xFFL }
        if (values.last() > lastMax) return null
        if (values.dropLast(1).any { it > 0xFFL }) return null
        var addr = values.last()
        values.dropLast(1).forEachIndexed { i, v -> addr = addr or (v shl (8 * (3 - i))) }
        if (addr > 0xFFFFFFFFL) return null
        return "${(addr shr 24) and 0xFF}.${(addr shr 16) and 0xFF}.${(addr shr 8) and 0xFF}.${addr and 0xFF}"
    }

    private fun isLoopback(host: String): Boolean {
        val h = host.removePrefix("[").removeSuffix("]")
        if (h == "localhost" || h == "::1" || h.endsWith(".localhost")) return true
        return toIpv4OrNull(h)?.startsWith("127.") == true
    }

    /** Link-local range (169.254.0.0/16), which includes the cloud instance-metadata address. */
    private fun isLinkLocal(host: String): Boolean {
        val h = host.removePrefix("[").removeSuffix("]")
        val mapped = IPV4_MAPPED.find(h)
        if (mapped != null) return isLinkLocal(mapped.groupValues[1])
        if (toIpv4OrNull(h)?.startsWith("169.254.") == true) return true
        // The whole 169.254/16 is a9fe:XXXX, compressed as `::ffff:a9fe:...` or `::a9fe:...`; core
        // blocks both and this side matched only the first, so the shorter form reached the network.
        return Regex("""^fe80:""", RegexOption.IGNORE_CASE).containsMatchIn(h) ||
            Regex("""^::(?:ffff:)?a9fe:""", RegexOption.IGNORE_CASE).containsMatchIn(h)
    }

    fun assertBaseUrl(url: String, carriesSecret: Boolean) {
        val uri = try {
            URI(url)
        } catch (e: URISyntaxException) {
            throw configError("The base URL is not a valid URL. Check the AskSQL provider settings.")
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            throw configError("The base URL must start with http:// or https://. Check the AskSQL provider settings.")
        }
        val host = uri.host ?: throw configError("The base URL has no host. Check the AskSQL provider settings.")
        if (!uri.userInfo.isNullOrEmpty()) {
            throw configError("Remove the user name or password from the base URL. Set the API key in AskSQL settings instead.")
        }
        if (isLinkLocal(host)) {
            throw configError("That base URL points at a link-local address, which is not a model endpoint.")
        }
        // Loopback is exempt from the https requirement: that is Ollama / LM Studio on this machine.
        if (carriesSecret && scheme != "https" && !isLoopback(host)) {
            throw configError("Refusing to send your API key over http to a remote host. Use https, or clear the key for a local endpoint.")
        }
    }

    private fun configError(message: String) = AskSqlException(AskSqlErrorCode.CONFIG_ERROR, userMessage = message)
}
