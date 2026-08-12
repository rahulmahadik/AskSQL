package com.rahulmahadik.asksql.ide.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Reported: deleting a connection and adding it back brought the old conversation with it. */
class ConversationResetTest {

    @Test fun `switching to a different connection clears the conversation`() {
        assertTrue(shouldClearConversation("a", "b"))
    }

    @Test fun `reselecting the same connection keeps it`() {
        assertFalse(shouldClearConversation("a", "a"))
        assertFalse(shouldClearConversation(null, null))
    }

    /** Deleting the last connection leaves nothing selected; the transcript still refers to a gone database. */
    @Test fun `deleting the last connection clears the conversation`() {
        assertTrue(shouldClearConversation("a", null))
    }

    /**
     * The reported sequence: chat on a connection, delete it, add the same schema back. The new
     * connection carries a new id, and the delete already reset the previous id to null, so the
     * old rule (which required both ids non-null) never fired.
     */
    @Test fun `adding a connection back after deleting does not restore the old conversation`() {
        assertTrue("delete", shouldClearConversation("a", null))
        assertTrue("re-add", shouldClearConversation(null, "a2"))
    }

    /** Even re-adding under the identical id must not resurrect a conversation the delete ended. */
    @Test fun `re-adding under the same id still clears, because the delete cleared first`() {
        assertTrue(shouldClearConversation("a", null))
        assertTrue(shouldClearConversation(null, "a"))
    }
}
