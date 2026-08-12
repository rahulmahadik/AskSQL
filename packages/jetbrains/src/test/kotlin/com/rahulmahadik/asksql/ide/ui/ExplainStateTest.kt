package com.rahulmahadik.asksql.ide.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** Reported: the Explain button stayed clickable after the description was already on screen. */
class ExplainStateTest {

    @Test fun `a described turn retires the button`() {
        assertEquals(ExplainState.DONE, explainStateAfter(stillInFlight = 0, succeeded = true))
    }

    @Test fun `a failed description leaves it offered, so it can be retried`() {
        assertEquals(ExplainState.IDLE, explainStateAfter(stillInFlight = 0, succeeded = false))
    }

    /** The automatic and the clicked description can overlap; the first to finish must not free the button. */
    @Test fun `another description still running keeps it busy`() {
        assertEquals(ExplainState.BUSY, explainStateAfter(stillInFlight = 1, succeeded = true))
        assertEquals(ExplainState.BUSY, explainStateAfter(stillInFlight = 1, succeeded = false))
    }
}
