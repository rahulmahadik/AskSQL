package com.rahulmahadik.asksql.ide.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Refresh Schema exists to pick up a table created outside the IDE, so it must never decay into a cached re-render. */
class ReloadCoalescerTest {

    @Test fun `the first reload starts, a second folds into it`() {
        val c = ReloadCoalescer()
        assertTrue(c.begin(forceRefresh = false))
        assertFalse(c.begin(forceRefresh = false))
    }

    @Test fun `a Refresh during a plain load survives as a forced follow-up`() {
        val c = ReloadCoalescer()
        c.begin(forceRefresh = false)
        c.begin(forceRefresh = true)
        assertEquals(true, c.finish(runFollowUp = true))
    }

    @Test fun `a plain reload queued after a Refresh does not downgrade it`() {
        val c = ReloadCoalescer()
        c.begin(forceRefresh = false)
        c.begin(forceRefresh = true)
        c.begin(forceRefresh = false)
        assertEquals(true, c.finish(runFollowUp = true))
    }

    @Test fun `nothing queued means no follow-up`() {
        val c = ReloadCoalescer()
        c.begin(forceRefresh = true)
        assertNull(c.finish(runFollowUp = true))
    }

    @Test fun `a failed load clears the busy flag so later refreshes still run`() {
        val c = ReloadCoalescer()
        c.begin(forceRefresh = false)
        c.finish(runFollowUp = true) // the load threw; finish() runs from a finally
        assertTrue(c.begin(forceRefresh = true))
    }

    @Test fun `a cancelled load drops its follow-up instead of restarting work on a disposed panel`() {
        val c = ReloadCoalescer()
        c.begin(forceRefresh = false)
        c.begin(forceRefresh = true)
        assertNull(c.finish(runFollowUp = false))
        assertTrue(c.begin(forceRefresh = false))
    }

    @Test fun `the follow-up flag does not leak into the next cycle`() {
        val c = ReloadCoalescer()
        c.begin(forceRefresh = false)
        c.begin(forceRefresh = true)
        assertEquals(true, c.finish(runFollowUp = true))
        c.begin(forceRefresh = false)
        c.begin(forceRefresh = false)
        assertEquals(false, c.finish(runFollowUp = true))
    }
}
