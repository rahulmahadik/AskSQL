package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirrors the core test: per-table row counts were blocked outright by the column floor. */
class SetOperationColumnTest {

    private fun table(name: String, column: String) = TableInfo(
        name = name, kind = TableKind.TABLE,
        columns = listOf(ColumnInfo(name = column, dbType = "int", nullable = false)),
    )

    private val catalog = SchemaCatalog(
        engine = EngineKind.SQLITE,
        tables = listOf(table("Album", "AlbumId"), table("Artist", "ArtistId")),
    )

    @Test fun `does not flag a UNION ALL of per-table counts`() {
        val sql = "SELECT 'Album' AS TableName, COUNT(*) AS RowCount FROM Album " +
            "UNION ALL SELECT 'Artist' AS TableName, COUNT(*) AS RowCount FROM Artist"

        assertNull(HallucinationChecks.firstUnknownColumn(sql, catalog))
    }

    @Test fun `still flags a hallucinated column on a plain select`() {
        assertNotNull(HallucinationChecks.firstUnknownColumn("SELECT Nope FROM Album", catalog))
    }

    /** A value containing "except" once disabled the floor entirely for an ordinary query. */
    @Test fun `still flags a hallucinated column when a literal contains a set-operation word`() {
        assertNotNull(HallucinationChecks.firstUnknownColumn("SELECT Nope FROM Album WHERE AlbumId = 'except this'", catalog))
    }
}
