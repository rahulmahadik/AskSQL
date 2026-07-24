package com.rahulmahadik.asksql.ide.llm

import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** The base URL is user-supplied and gets fetched with the API key attached, so it is a real SSRF and key-leak surface. */
class BaseUrlGuardTest {

    private fun assertBlocked(url: String, carriesSecret: Boolean = false) {
        val e = assertThrows(AskSqlException::class.java) { BaseUrlGuard.assertBaseUrl(url, carriesSecret) }
        assertEquals(AskSqlErrorCode.CONFIG_ERROR, e.code)
    }

    // ---- Legacy inet_aton encodings of 169.254.169.254 (cloud instance metadata) ----

    @Test fun `dotted-quad link-local is blocked`() = assertBlocked("http://169.254.169.254/latest/meta-data/")

    @Test fun `decimal-encoded link-local is blocked`() = assertBlocked("http://2852039166/latest/meta-data/")

    @Test fun `hex-encoded link-local is blocked`() = assertBlocked("http://0xA9FEA9FE/latest/meta-data/")

    @Test fun `octal-encoded link-local is blocked`() = assertBlocked("http://0251.0376.0251.0376/")

    @Test fun `two-part link-local is blocked`() = assertBlocked("http://169.16689662/")

    @Test fun `ipv4-mapped ipv6 link-local is blocked`() = assertBlocked("http://[::ffff:169.254.169.254]/")

    // ---- Encodings must resolve to the same address ----

    @Test fun `every encoding normalizes to the same dotted quad`() {
        assertEquals("169.254.169.254", BaseUrlGuard.toIpv4OrNull("2852039166"))
        assertEquals("169.254.169.254", BaseUrlGuard.toIpv4OrNull("0xA9FEA9FE"))
        assertEquals("169.254.169.254", BaseUrlGuard.toIpv4OrNull("169.254.169.254"))
        assertEquals("127.0.0.1", BaseUrlGuard.toIpv4OrNull("2130706433"))
    }

    @Test fun `a hostname is not mistaken for a numeric address`() {
        assertNull(BaseUrlGuard.toIpv4OrNull("api.openai.com"))
        assertNull(BaseUrlGuard.toIpv4OrNull("localhost"))
        assertNull(BaseUrlGuard.toIpv4OrNull("999.1.1.1"))
    }

    // ---- Legitimate endpoints must keep working ----

    @Test fun `an ordinary https provider is allowed, with a key`() {
        BaseUrlGuard.assertBaseUrl("https://api.openai.com/v1", carriesSecret = true)
    }

    @Test fun `a local Ollama endpoint over http is allowed, keyless and keyed`() {
        BaseUrlGuard.assertBaseUrl("http://localhost:11434/v1", carriesSecret = false)
        BaseUrlGuard.assertBaseUrl("http://127.0.0.1:11434/v1", carriesSecret = true)
    }

    /** A private-network LLM gateway is a normal enterprise setup, so RFC1918 stays allowed. */
    @Test fun `a private-network gateway is still allowed`() {
        BaseUrlGuard.assertBaseUrl("https://10.0.0.5/v1", carriesSecret = true)
        BaseUrlGuard.assertBaseUrl("https://192.168.1.20/v1", carriesSecret = true)
    }

    // ---- Key leaks and malformed input ----

    @Test fun `sending a key over plaintext to a remote host is refused`() =
        assertBlocked("http://api.example.com/v1", carriesSecret = true)

    @Test fun `credentials embedded in the URL are refused`() =
        assertBlocked("https://user:pass@gateway.example.com/v1", carriesSecret = false)

    @Test fun `a non-http scheme is refused`() = assertBlocked("file:///etc/passwd")

    @Test fun `a malformed URL is refused`() = assertBlocked("not a url at all")

    /** The URL can embed a password, so it must never be echoed back in the error text. */
    @Test fun `the raw URL never appears in the error message`() {
        val e = assertThrows(AskSqlException::class.java) {
            BaseUrlGuard.assertBaseUrl("https://user:hunter2@gateway.example.com/v1", carriesSecret = false)
        }
        assertEquals(false, e.userMessage.contains("hunter2"))
    }
}
