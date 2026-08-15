package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * These checks fail open, so one that stops firing looks exactly like a clean query. The TypeScript
 * side went quiet on any Oracle statement carrying `FETCH FIRST n ROWS ONLY`, which is what a top-N
 * question produces; this pins the same shapes here.
 */
class ChecksAliveTest {

    private fun col(name: String) = ColumnInfo(name = name, dbType = "varchar", nullable = true)

    private val catalog = SchemaCatalog(
        engine = EngineKind.ORACLE,
        schemas = listOf("CHINOOK"),
        tables = listOf(
            TableInfo(schema = null, name = "ALBUM", kind = com.rahulmahadik.asksql.ide.model.TableKind.TABLE, columns = listOf(col("ALBUMID"), col("TITLE"), col("ARTISTID"))),
            TableInfo(schema = null, name = "ARTIST", kind = com.rahulmahadik.asksql.ide.model.TableKind.TABLE, columns = listOf(col("ARTISTID"), col("NAME"))),
        ),
    )

    private val tails = listOf(
        "",
        "FETCH FIRST 50 ROWS ONLY",
        "FETCH NEXT 1 ROWS ONLY",
        "OFFSET 5 ROWS FETCH NEXT 50 ROWS ONLY",
    )

    @Test fun `the column floor fires whatever row-limit tail the query carries`() {
        for (tail in tails) {
            val sql = "SELECT A.NAME FROM ALBUM A ORDER BY A.TITLE $tail".trim()
            assertNotNull(sql, HallucinationChecks.firstUnknownColumn(sql, catalog))
        }
    }

    @Test fun `a real column is left alone whatever tail it carries`() {
        for (tail in tails) {
            val sql = "SELECT A.TITLE FROM ALBUM A $tail".trim()
            assertNull(sql, HallucinationChecks.firstUnknownColumn(sql, catalog))
        }
    }

    @Test fun `the no-op pipeline check reads shell JSON, which is what a small model writes`() {
        // The TypeScript side read this with plain JSON.parse and was silently off for shell form.
        for (pipeline in listOf(
            "[{\"\u0024limit\": 1000}]",
            "[{\u0024limit: 1000}]",
            "[{\u0024sort: {_id: 1}}, {\u0024limit: 10}]",
        )) {
            assertTrue(pipeline, MongoEnginePipeline.isNoOpPipeline(pipeline))
        }
    }

    @Test fun `a pipeline that actually computes is not a no-op, in either form`() {
        for (pipeline in listOf(
            "[{\"\u0024group\": {\"_id\": \"\u0024status\"}}]",
            "[{\u0024group: {_id: \u0024status}}]",
        )) {
            assertTrue(pipeline, !MongoEnginePipeline.isNoOpPipeline(pipeline))
        }
    }
}
