package com.rahulmahadik.asksql.ide.ui

import com.rahulmahadik.asksql.ide.llm.ProviderKind
import org.junit.Assert.assertEquals
import org.junit.Test

/** Direct unit coverage for [formatModelLabel] - the toolbar label's text logic, extracted out of [ChatPanel] specifically so it's testable without a real Project/Settings fixture (see [ConnectionEditorDialogValidationTest]'s class doc for why that's not available in this test module). */
class ChatPanelModelLabelTest {

    @Test fun `shows provider and model when both are configured`() {
        assertEquals("Model: openai · gpt-4o-mini", formatModelLabel(ProviderKind.OPENAI, "gpt-4o-mini"))
    }

    @Test fun `wireName is used, not the raw enum name`() {
        assertEquals("Model: lm-studio · qwen2.5-coder:14b", formatModelLabel(ProviderKind.LM_STUDIO, "qwen2.5-coder:14b"))
    }

    @Test fun `shows not-configured when provider is null`() {
        assertEquals("Model: not configured", formatModelLabel(null, "gpt-4o-mini"))
    }

    @Test fun `shows not-configured when model is blank, even with a provider set`() {
        assertEquals("Model: not configured", formatModelLabel(ProviderKind.OPENAI, ""))
        assertEquals("Model: not configured", formatModelLabel(ProviderKind.OPENAI, "   "))
    }

    @Test fun `shows not-configured when both are missing`() {
        assertEquals("Model: not configured", formatModelLabel(null, ""))
    }
}
