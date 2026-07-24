package com.rahulmahadik.asksql.ide.errors

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** [ErrorPresenter.present] must classify a coroutine cancellation as [AskSqlErrorCode.CANCELLED], not fall through to the generic "unexpected exception" branch. */
class ErrorPresenterTest {

    @Test fun `a CancellationException is classified as CANCELLED, not UNKNOWN`() {
        val result = ErrorPresenter.present(kotlinx.coroutines.CancellationException("stopped by user"))
        assertEquals(AskSqlErrorCode.CANCELLED, result.code)
        assertFalse(result.retryable)
    }

    @Test fun `an already-typed AskSqlException passes through unchanged`() {
        val original = AskSqlException(AskSqlErrorCode.DB_UNREACHABLE, userMessage = "custom message")
        val result = ErrorPresenter.present(original)
        assertEquals(original, result)
    }

    // The genuinely-unexpected-exception path (falls through to log.error)
    // is deliberately NOT covered here: IntelliJ's test-mode Logger turns
    // Logger.error() into a thrown test failure by design, to catch silent
    // errors during tests; exercising that path here would just be
    // asserting the platform's own test-logger behavior, not this class's.
}
