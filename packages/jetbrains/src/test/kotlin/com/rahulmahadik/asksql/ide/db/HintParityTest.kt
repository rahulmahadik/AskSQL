package com.rahulmahadik.asksql.ide.db

import com.google.gson.JsonParser
import com.rahulmahadik.asksql.ide.db.introspect.SqliteIntrospector
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.sql.DriverManager

/**
 * The Kotlin half of the derived-hint specification in tools/parity/vectors/hints.json. The TypeScript
 * half is packages/sqlite/test/hint-parity.test.ts, and both assert the SAME expectations, so a change
 * on one side fails on that side instead of quietly becoming the new truth.
 *
 * This exists because the two implementations had already drifted once: this file's hand-rolled JSON
 * parser accepted `{not json` as a valid empty object where JSON.parse throws, so the same column was
 * called JSON in Android Studio and not in VS Code.
 */
class HintParityTest {

    private data class Vector(
        val name: String,
        val column: String,
        val dbType: String,
        val rows: List<Any>,
        val expect: String?,
    )

    private fun loadVectors(): List<Vector> {
        val candidates = listOf(
            File("tools/parity/vectors/hints.json"),
            File("../tools/parity/vectors/hints.json"),
            File(System.getProperty("user.dir"), "tools/parity/vectors/hints.json"),
        )
        val file = candidates.firstOrNull { it.exists() }
            ?: error("hints.json not found; looked in ${candidates.joinToString { it.absolutePath }}")
        return JsonParser.parseString(file.readText()).asJsonObject
            .getAsJsonArray("vectors")
            .map { it.asJsonObject }
            .map { o ->
                Vector(
                    name = o.get("name").asString,
                    column = o.get("column").asString,
                    dbType = o.get("dbType").asString,
                    rows = o.getAsJsonArray("rows").map { r ->
                        val prim = r.asJsonPrimitive
                        if (prim.isNumber) prim.asLong else prim.asString
                    },
                    expect = o.get("expect").takeUnless { it.isJsonNull }?.asString,
                )
            }
    }

    private fun commentFor(v: Vector): String? {
        Class.forName("org.sqlite.JDBC")
        val file = File.createTempFile("asksql-parity", ".sqlite").also { it.deleteOnExit() }
        DriverManager.getConnection("jdbc:sqlite:${file.path}").use { c ->
            c.createStatement().use { st ->
                st.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, \"${v.column}\" ${v.dbType})")
            }
            c.prepareStatement("INSERT INTO t (\"${v.column}\") VALUES (?)").use { ps ->
                for (row in v.rows) {
                    when (row) {
                        is Long -> ps.setLong(1, row)
                        else -> ps.setString(1, row.toString())
                    }
                    ps.executeUpdate()
                }
            }
            val catalog = SqliteIntrospector.introspect(c)
            return catalog.tables.first { it.name == "t" }.columns.first { it.name == v.column }.comment
        }
    }

    @Test
    fun `every shared vector produces the same hint as the TypeScript implementation`() {
        val vectors = loadVectors()
        assertTrue("an empty spec must not pass silently", vectors.size > 15)
        val mismatches = vectors.mapNotNull { v ->
            val actual = commentFor(v)
            if (actual == v.expect) null else "${v.name}\n     expected: ${v.expect}\n     actual  : $actual"
        }
        assertEquals("hint parity broken for ${mismatches.size} vector(s):\n${mismatches.joinToString("\n")}", 0, mismatches.size)
    }
}
