package com.rahulmahadik.asksql.ide.ui

import com.rahulmahadik.asksql.ide.model.Stage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Stage labels: a pipeline turn never names SQL or tables. */
class StageLabelTest {

    @Test fun `a mongo turn is never told SQL or tables`() {
        for (stage in Stage.entries) {
            val label = stageLabel(stage, isSql = false)
            assertFalse("stage $stage said SQL: $label", label.contains("SQL"))
            assertFalse("stage $stage said tables: $label", label.contains("table"))
        }
    }

    @Test fun `a mongo turn names pipelines and collections`() {
        assertEquals("Finding relevant collections…", stageLabel(Stage.PRUNE, isSql = false))
        assertEquals("Writing the pipeline…", stageLabel(Stage.LLM, isSql = false))
        assertEquals("Correcting the pipeline…", stageLabel(Stage.REPAIR, isSql = false))
    }

    @Test fun `a sql turn keeps the original wording`() {
        assertEquals("Finding relevant tables…", stageLabel(Stage.PRUNE, isSql = true))
        assertEquals("Writing SQL…", stageLabel(Stage.LLM, isSql = true))
        assertEquals("Correcting the SQL…", stageLabel(Stage.REPAIR, isSql = true))
    }

    @Test fun `engine-neutral stages read the same either way`() {
        for (stage in listOf(Stage.CATALOG, Stage.EXTRACT, Stage.GUARD, Stage.EXECUTE, Stage.DONE)) {
            assertEquals("stage $stage", stageLabel(stage, isSql = true), stageLabel(stage, isSql = false))
        }
    }

    /** Only DONE clears the spinner. */
    @Test fun `every stage but DONE has a label`() {
        for (stage in Stage.entries.filter { it != Stage.DONE }) {
            assertTrue("stage $stage had no label", stageLabel(stage, isSql = true).isNotBlank())
            assertTrue("stage $stage had no label", stageLabel(stage, isSql = false).isNotBlank())
        }
        assertEquals("", stageLabel(Stage.DONE, isSql = true))
    }
}
