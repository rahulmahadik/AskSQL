package com.rahulmahadik.asksql.ide.integrations.database

import com.rahulmahadik.asksql.ide.test.fakeProject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests the fail-soft contract: when `com.intellij.database` isn't on the classpath (true for every Community-only IDE at runtime), this never throws and never fabricates a result. */
class DataSourceImporterTest {

    @Test fun `reports the database plugin as unavailable on a Community-only classpath`() {
        assertFalse(DataSourceImporter.isDatabasePluginAvailable())
    }

    @Test fun `returns an empty list rather than throwing when the database plugin is absent`() {
        val result = DataSourceImporter.listImportableDataSources(fakeProject())
        assertTrue(result.isEmpty())
    }
}
