package com.rahulmahadik.asksql.ide.ui

import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.ColumnKind
import com.rahulmahadik.asksql.ide.model.ResultColumn

enum class ChartKind { BAR, LINE }

data class ChartPoint(val label: String, val value: Double)

data class ChartSeries(val name: String, val points: List<ChartPoint>)

data class ChartSpec(val kind: ChartKind, val labelColumn: String, val series: List<ChartSeries>)

/**
 * Chart-shape inference, the Kotlin half of the React package's `chart.ts`. Pure and Swing-free.
 * One label column plus a numeric column is a bar; a date label makes it a line; anything else is a table.
 */
object Charts {

    /** Past this many rows the bars are too thin to read anything from. */
    private const val MAX_BARS = 50

    /** Extra series crowd the plot; the table still holds every column. */
    private const val MAX_SERIES = 4

    /** Type kinds are trusted; anything else is decided by reading this many rows. */
    private const val SAMPLE_ROWS = 20

    /** The spec to draw, or null when a chart would say less than the table does. */
    fun infer(result: AskSqlResultSet): ChartSpec? {
        if (result.rows.isEmpty() || result.columns.size < 2 || result.rows.size > MAX_BARS) return null

        val numericIdx = result.columns.indices.filter { isNumeric(result, it) }
        if (numericIdx.isEmpty()) return null

        // The label is the first non-numeric column; an all-numeric result falls back to its first column.
        val labelIdx = result.columns.indices.firstOrNull { it !in numericIdx } ?: 0
        val valueIdx = numericIdx.filter { it != labelIdx }
        if (valueIdx.isEmpty()) return null

        val labelColumn = result.columns[labelIdx]
        val series = valueIdx.take(MAX_SERIES).map { column ->
            ChartSeries(
                name = result.columns[column].name,
                points = result.rows.map { row ->
                    ChartPoint(label = label(row[labelIdx]), value = toNumber(row[column]) ?: 0.0)
                },
            )
        }
        return ChartSpec(if (isTemporal(labelColumn)) ChartKind.LINE else ChartKind.BAR, labelColumn.name, series)
    }

    private fun isNumeric(result: AskSqlResultSet, index: Int): Boolean {
        when (result.columns[index].kind) {
            ColumnKind.NUMBER, ColumnKind.BIGINT, ColumnKind.DECIMAL -> return true
            else -> Unit
        }
        // A driver that reports NUMERIC as text still charts, as long as every sampled cell parses.
        val sample = result.rows.take(SAMPLE_ROWS)
        return sample.isNotEmpty() &&
            sample.any { it[index] !is CellValue.Null } &&
            sample.all { it[index] is CellValue.Null || toNumber(it[index]) != null }
    }

    private fun isTemporal(column: ResultColumn): Boolean =
        column.kind == ColumnKind.DATE || column.kind == ColumnKind.TIMESTAMP

    /** NaN and Infinity cannot be plotted - they reach Graphics2D as a coordinate and throw. */
    private fun toNumber(cell: CellValue): Double? = when (cell) {
        is CellValue.Number -> cell.value
        is CellValue.ExactNumeric -> cell.value.toDoubleOrNull()
        is CellValue.Text -> cell.value.trim().takeIf { it.isNotEmpty() }?.toDoubleOrNull()
        else -> null
    }?.takeIf { it.isFinite() }

    private fun label(cell: CellValue): String = when (cell) {
        is CellValue.Null -> "∅"
        is CellValue.Text -> cell.value
        is CellValue.ExactNumeric -> cell.value
        is CellValue.Boolean -> cell.value.toString()
        // A whole number reads as "2026", not "2026.0"; a fraction keeps its digits.
        is CellValue.Number -> if (cell.value == Math.floor(cell.value) && !cell.value.isInfinite()) {
            cell.value.toLong().toString()
        } else {
            cell.value.toString()
        }
        is CellValue.Binary -> "⟨binary⟩"
    }
}
