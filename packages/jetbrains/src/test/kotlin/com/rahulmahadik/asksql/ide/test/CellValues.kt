package com.rahulmahadik.asksql.ide.test

import com.rahulmahadik.asksql.ide.model.CellValue

/**
 * The numeric value of a cell whatever wrapper carries it. A test that asserts the wrapper instead
 * of the value fails when a column's type mapping changes, even though the number is still right.
 */
fun numericOrNull(cell: CellValue?): Double? = when (cell) {
    is CellValue.Number -> cell.value
    is CellValue.ExactNumeric -> cell.value.toDoubleOrNull()
    is CellValue.Text -> cell.value.trim().toDoubleOrNull()
    else -> null
}
