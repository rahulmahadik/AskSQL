package com.rahulmahadik.asksql.ide.ui

import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.ColumnKind
import com.rahulmahadik.asksql.ide.model.ResultColumn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Kotlin half of the React package's `chart.test.ts`, case for case. A divergence shows up as a
 * result the web UI charts and the plugin refuses to, or the reverse.
 */
class ChartsTest {

    private fun result(columns: List<ResultColumn>, rows: List<List<CellValue>>) =
        AskSqlResultSet(columns = columns, rows = rows, rowCount = rows.size, truncated = false, durationMs = 1)

    private fun text(value: String) = CellValue.Text(value)
    private fun number(value: Double) = CellValue.Number(value)

    @Test
    fun `category plus numeric is a bar chart`() {
        val spec = Charts.infer(
            result(
                listOf(ResultColumn("region", kind = ColumnKind.TEXT), ResultColumn("total", kind = ColumnKind.NUMBER)),
                listOf(
                    listOf(text("EU"), number(100.0)),
                    listOf(text("NA"), number(250.0)),
                    listOf(text("APAC"), number(75.0)),
                ),
            ),
        )
        assertEquals(ChartKind.BAR, spec?.kind)
        assertEquals("region", spec?.labelColumn)
        assertEquals(listOf(100.0, 250.0, 75.0), spec?.series?.first()?.points?.map { it.value })
        assertEquals(listOf("EU", "NA", "APAC"), spec?.series?.first()?.points?.map { it.label })
    }

    @Test
    fun `a date label makes it a line chart`() {
        val spec = Charts.infer(
            result(
                listOf(ResultColumn("day", kind = ColumnKind.DATE), ResultColumn("revenue", kind = ColumnKind.BIGINT)),
                listOf(
                    listOf(text("2026-01-01"), CellValue.ExactNumeric("10")),
                    listOf(text("2026-01-02"), CellValue.ExactNumeric("20")),
                ),
            ),
        )
        assertEquals(ChartKind.LINE, spec?.kind)
    }

    @Test
    fun `every numeric column becomes its own series`() {
        val spec = Charts.infer(
            result(
                listOf(
                    ResultColumn("region", kind = ColumnKind.TEXT),
                    ResultColumn("sales", kind = ColumnKind.NUMBER),
                    ResultColumn("refunds", kind = ColumnKind.NUMBER),
                ),
                listOf(
                    listOf(text("EU"), number(100.0), number(5.0)),
                    listOf(text("NA"), number(200.0), number(8.0)),
                ),
            ),
        )
        assertEquals(2, spec?.series?.size)
    }

    @Test
    fun `an all-text result is not chartable`() {
        val spec = Charts.infer(
            result(
                listOf(ResultColumn("a", kind = ColumnKind.TEXT), ResultColumn("b", kind = ColumnKind.TEXT)),
                listOf(listOf(text("x"), text("y"))),
            ),
        )
        assertNull(spec)
    }

    @Test
    fun `a single column is not chartable`() {
        assertNull(Charts.infer(result(listOf(ResultColumn("n", kind = ColumnKind.NUMBER)), listOf(listOf(number(1.0))))))
    }

    @Test
    fun `too many rows is not chartable`() {
        val rows = (0 until 60).map { listOf(text("c$it"), number(it.toDouble())) }
        val spec = Charts.infer(
            result(listOf(ResultColumn("k", kind = ColumnKind.TEXT), ResultColumn("v", kind = ColumnKind.NUMBER)), rows),
        )
        assertNull(spec)
    }

    @Test
    fun `zero rows is not chartable`() {
        val spec = Charts.infer(
            result(listOf(ResultColumn("k", kind = ColumnKind.TEXT), ResultColumn("v", kind = ColumnKind.NUMBER)), emptyList()),
        )
        assertNull(spec)
    }

    /** A driver that hands back NUMERIC as text must still chart, or MySQL aggregates never would. */
    @Test
    fun `numbers arriving as text still count as numeric`() {
        val spec = Charts.infer(
            result(
                listOf(ResultColumn("status", kind = ColumnKind.TEXT), ResultColumn("orders", kind = ColumnKind.TEXT)),
                listOf(listOf(text("open"), text("12")), listOf(text("closed"), text("30"))),
            ),
        )
        assertEquals(ChartKind.BAR, spec?.kind)
        assertEquals(listOf(12.0, 30.0), spec?.series?.first()?.points?.map { it.value })
    }

    /** An all-null column carries no shape, so it must not be mistaken for a numeric series. */
    @Test
    fun `an all-null column is not a series`() {
        val spec = Charts.infer(
            result(
                listOf(ResultColumn("k", kind = ColumnKind.TEXT), ResultColumn("v", kind = ColumnKind.TEXT)),
                listOf(listOf(text("a"), CellValue.Null), listOf(text("b"), CellValue.Null)),
            ),
        )
        assertNull(spec)
    }

    /** The single most common shape a chart helps with: "how many of each". */
    @Test
    fun `a count by category charts`() {
        val spec = Charts.infer(
            result(
                listOf(ResultColumn("status", kind = ColumnKind.TEXT), ResultColumn("count", kind = ColumnKind.BIGINT)),
                listOf(
                    listOf(text("open"), CellValue.ExactNumeric("42")),
                    listOf(text("closed"), CellValue.ExactNumeric("17")),
                ),
            ),
        )
        assertEquals(ChartKind.BAR, spec?.kind)
        assertEquals(listOf(42.0, 17.0), spec?.series?.first()?.points?.map { it.value })
    }
}
