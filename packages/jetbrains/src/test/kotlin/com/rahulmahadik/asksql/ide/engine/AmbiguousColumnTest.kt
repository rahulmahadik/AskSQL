package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirrors the ambiguous-column tests in packages/core/test/table-case-repair.test.ts. */
class AmbiguousColumnTest {

    private fun table(name: String, cols: List<String>) = TableInfo(
        name = name,
        kind = TableKind.TABLE,
        columns = cols.map { ColumnInfo(name = it, dbType = "int", nullable = true) },
    )

    private val catalog = SchemaCatalog(
        engine = EngineKind.POSTGRES,
        tables = listOf(table("a", listOf("id", "v")), table("b", listOf("id", "w")), table("c", listOf("cid", "z"))),
    )

    /** Two joined tables both own it, so the database rejects the bare name. */
    @Test fun `names the column both tables own`() {
        assertEquals("id", HallucinationChecks.ambiguousColumn("SELECT id, v, w FROM a JOIN b ON a.id = b.id", catalog))
    }

    /** A USING or NATURAL join makes the shared column legal unqualified. */
    @Test fun `leaves unambiguous statements alone`() {
        for (sql in listOf(
            "SELECT a.id, v, w FROM a JOIN b ON a.id = b.id",
            "SELECT id, v, w FROM a JOIN b USING (id)",
            "SELECT id FROM a NATURAL JOIN b",
            "SELECT id, v FROM a",
            "SELECT v, z FROM a JOIN c ON a.id = c.cid",
            "SELECT v FROM a JOIN c ON a.id = c.cid WHERE v = 'id'",
        )) {
            assertNull(sql, HallucinationChecks.ambiguousColumn(sql, catalog))
        }
    }

    /** A scope this cannot model is left to the database rather than guessed at. */
    @Test fun `says nothing about a subquery`() {
        assertNull(HallucinationChecks.ambiguousColumn("SELECT id FROM a WHERE id IN (SELECT id FROM b)", catalog))
    }
}
