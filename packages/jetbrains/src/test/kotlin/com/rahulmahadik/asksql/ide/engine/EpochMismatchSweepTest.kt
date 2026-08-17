package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Room has no date type: a timestamp is an INTEGER of epoch milliseconds. Against a text date nothing
 * matches and zero is reported; against epoch seconds every row matches. Measured: 7B answered 0 where
 * the truth was 2, 30B answered 5. Sweeps the cross product, since firing on TEXT would refuse correct
 * SQL. Mirrors epoch-mismatch-sweep.test.ts.
 */
class EpochMismatchSweepTest {

    private val numericTypes = listOf("INTEGER", "INT", "int", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT", "INT8", "NUMERIC")
    private val dateSafeTypes = listOf("TEXT", "VARCHAR(32)", "DATE", "TIMESTAMP", "DATETIME", "REAL", "BLOB", "BOOLEAN")

    private val dateExpressions = listOf(
        "date('now')",
        "date('now','-7 days')",
        "datetime('now')",
        "strftime('%s','now')",
        "strftime('%Y-%m-%d','now')",
        "julianday('now')",
        "CURRENT_DATE",
        "CURRENT_TIMESTAMP",
        "'2026-08-09'",
        "'2026-08-09 12:30:00'",
    )
    private val safeExpressions = listOf(
        "1755300000000",
        "0",
        "(strftime('%s','now') - 7*86400) * 1000",
        "(strftime('%s','now') - 7*86400)",
        "other_number",
        "'not-a-date'",
        "'2026'",
    )
    private val operators = listOf(">=", ">", "<", "<=", "=", "<>")

    private val shapes: List<(String, String, String) -> String> = listOf(
        { l, o, r -> "SELECT * FROM events WHERE $l $o $r" },
        { l, o, r -> "SELECT * FROM events e WHERE e.$l $o $r" },
        { l, o, r -> "SELECT * FROM events WHERE $r $o $l" },
        { l, o, r -> "SELECT * FROM events WHERE label = 'x' AND $l $o $r" },
        { l, o, r -> "SELECT * FROM events WHERE label = 'x' OR $l $o $r" },
        { l, o, r -> "SELECT COUNT(*) FROM events WHERE $l $o $r" },
        { l, o, r -> "SELECT label, COUNT(*) FROM events WHERE $l $o $r GROUP BY label" },
        { l, o, r -> "SELECT * FROM events JOIN people ON people.id = events.person_id WHERE $l $o $r" },
    )

    private fun col(name: String, dbType: String) = ColumnInfo(name = name, dbType = dbType, nullable = true)

    private fun catalogWith(dbType: String) = SchemaCatalog(
        engine = EngineKind.SQLITE,
        schemas = emptyList(),
        tables = listOf(
            TableInfo(
                schema = null,
                name = "events",
                kind = TableKind.TABLE,
                columns = listOf(col("happened_at", dbType), col("other_number", "INTEGER"), col("label", "TEXT"), col("person_id", "INTEGER")),
            ),
            TableInfo(schema = null, name = "people", kind = TableKind.TABLE, columns = listOf(col("id", "INTEGER"))),
        ),
    )

    @Test fun `every date expression against a numeric column is flagged, in every shape`() {
        val missed = mutableListOf<String>()
        var checked = 0
        for (dbType in numericTypes) {
            val catalog = catalogWith(dbType)
            for (expr in dateExpressions) for (op in operators) for (shape in shapes) {
                val sql = shape("happened_at", op, expr)
                checked++
                if (Semantics.epochUnitMismatch(sql, catalog) == null) missed += "$dbType: $sql"
            }
        }
        assertEquals(numericTypes.size * dateExpressions.size * operators.size * shapes.size, checked)
        assertEquals("${missed.size} of $checked not flagged, e.g. ${missed.firstOrNull()}", emptyList<String>(), missed)
    }

    @Test fun `a column that legitimately holds a date is never flagged`() {
        val wrong = mutableListOf<String>()
        for (dbType in dateSafeTypes) {
            val catalog = catalogWith(dbType)
            for (expr in dateExpressions) for (op in operators) for (shape in shapes) {
                val sql = shape("happened_at", op, expr)
                if (Semantics.epochUnitMismatch(sql, catalog) != null) wrong += "$dbType: $sql"
            }
        }
        assertEquals("${wrong.size} correct queries refused, e.g. ${wrong.firstOrNull()}", emptyList<String>(), wrong)
    }

    @Test fun `a numeric column compared numerically is never flagged`() {
        val wrong = mutableListOf<String>()
        for (dbType in numericTypes) {
            val catalog = catalogWith(dbType)
            for (expr in safeExpressions) for (op in operators) for (shape in shapes) {
                val sql = shape("happened_at", op, expr)
                if (Semantics.epochUnitMismatch(sql, catalog) != null) wrong += "$dbType: $sql"
            }
        }
        assertEquals("${wrong.size} correct queries refused, e.g. ${wrong.firstOrNull()}", emptyList<String>(), wrong)
    }

    @Test fun `shapes that must never be judged at all`() {
        val catalog = catalogWith("INTEGER")
        // A date expression in the SELECT list is not a comparison.
        assertEquals(null, Semantics.epochUnitMismatch("SELECT date('now') AS today, happened_at FROM events", catalog))
        // A column the catalog does not know is left alone.
        assertEquals(null, Semantics.epochUnitMismatch("SELECT * FROM events WHERE unknown_col >= date('now')", catalog))
        // IS NULL is not a date comparison.
        assertEquals(null, Semantics.epochUnitMismatch("SELECT * FROM events WHERE happened_at IS NOT NULL", catalog))
        // Unparsable SQL fails open rather than blocking.
        assertEquals(null, Semantics.epochUnitMismatch("SELECT FROM WHERE", catalog))
    }

    @Test fun `a name two tables type differently is not attributable`() {
        val ambiguous = SchemaCatalog(
            engine = EngineKind.SQLITE,
            schemas = emptyList(),
            tables = listOf(
                TableInfo(schema = null, name = "events", kind = TableKind.TABLE, columns = listOf(col("happened_at", "INTEGER"))),
                TableInfo(schema = null, name = "logs", kind = TableKind.TABLE, columns = listOf(col("happened_at", "TEXT"))),
            ),
        )
        assertEquals(null, Semantics.epochUnitMismatch("SELECT * FROM events WHERE happened_at >= date('now')", ambiguous))
    }
}
