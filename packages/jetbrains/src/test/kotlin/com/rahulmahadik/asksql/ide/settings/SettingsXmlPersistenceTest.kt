package com.rahulmahadik.asksql.ide.settings

import com.intellij.util.xmlb.XmlSerializer
import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Everything the user configures has to come back after a restart, not just connections. */
class SettingsXmlPersistenceTest {

    private fun roundTrip(state: AskSqlAppState): AskSqlAppState =
        XmlSerializer.deserialize(XmlSerializer.serialize(state), AskSqlAppState::class.java)

    @Test fun `provider and model survive a restart`() {
        val back = roundTrip(AskSqlAppState(provider = "ollama", model = "qwen2.5-coder:7b", baseUrl = "http://localhost:11434"))

        assertEquals("ollama", back.provider)
        assertEquals("qwen2.5-coder:7b", back.model)
        assertEquals("http://localhost:11434", back.baseUrl)
    }

    @Test fun `numeric limits survive a restart`() {
        val back = roundTrip(AskSqlAppState(maxRows = 250, maxSchemaTokens = 9000))

        assertEquals(250, back.maxRows)
        assertEquals(9000, back.maxSchemaTokens)
    }

    /** Reverting to the default here fails open: queries run without the approval the user asked for. */
    @Test fun `requireApproval stays on across a restart`() {
        assertTrue(roundTrip(AskSqlAppState(requireApproval = true)).requireApproval)
    }

    @Test fun `the remaining toggles survive in both directions`() {
        val on = roundTrip(AskSqlAppState(allowDataInPrompt = true, explainAutomatically = true, answerSchemaQuestions = true))
        assertTrue(on.allowDataInPrompt)
        assertTrue(on.explainAutomatically)
        assertTrue(on.answerSchemaQuestions)

        val off = roundTrip(AskSqlAppState(allowDataInPrompt = false, explainAutomatically = false, answerSchemaQuestions = false))
        assertFalse(off.allowDataInPrompt)
        assertFalse(off.explainAutomatically)
        assertFalse(off.answerSchemaQuestions)
    }

    @Test fun `custom instructions and glossary survive a restart`() {
        val back = roundTrip(AskSqlAppState(customInstructions = "prefer CTEs", glossary = "ARR = annual recurring revenue"))

        assertEquals("prefer CTEs", back.customInstructions)
        assertEquals("ARR = annual recurring revenue", back.glossary)
    }

    /** xmlb collects only non-final fields, so a `val` in a state class is dropped on save with no error. */
    @Test fun `no persisted state field is final`() {
        for (cls in listOf(AskSqlAppState::class.java, AskSqlProjectState::class.java, ConnectionState::class.java)) {
            val finals = cls.declaredFields
                .filterNot { Modifier.isStatic(it.modifiers) }
                .filter { Modifier.isFinal(it.modifiers) }
                .map { it.name }

            assertEquals("${cls.simpleName} has final fields, which xmlb drops on save: $finals", emptyList<String>(), finals)
        }
    }
}
