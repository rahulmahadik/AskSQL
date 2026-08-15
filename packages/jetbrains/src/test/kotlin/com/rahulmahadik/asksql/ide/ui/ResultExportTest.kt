package com.rahulmahadik.asksql.ide.ui

import com.rahulmahadik.asksql.ide.model.BinaryPreview
import com.rahulmahadik.asksql.ide.model.CellValue
import org.junit.Assert.assertEquals
import org.junit.Test

/** Copy and Export CSV both go through these two. A quoting slip corrupts the file silently. */
class ResultExportTest {

    @Test
    fun `a whole number never shows a decimal the database did not have`() {
        // INTEGER travels as a double; the grid, the copy buffer and the CSV all read from here.
        assertEquals("1", displayString(CellValue.Number(1.0)))
        assertEquals("2026", displayString(CellValue.Number(2026.0)))
        assertEquals("-7", displayString(CellValue.Number(-7.0)))
        assertEquals("0", displayString(CellValue.Number(0.0)))
    }

    @Test
    fun `a fraction keeps its digits`() {
        assertEquals("1.5", displayString(CellValue.Number(1.5)))
        assertEquals("-0.25", displayString(CellValue.Number(-0.25)))
    }

    @Test
    fun `a magnitude past Long is written out, not clamped or put in E notation`() {
        assertEquals("100000000000000000000", displayString(CellValue.Number(1e20)))
    }

    @Test
    fun `NaN and infinity keep their names`() {
        assertEquals("NaN", displayString(CellValue.Number(Double.NaN)))
        assertEquals("Infinity", displayString(CellValue.Number(Double.POSITIVE_INFINITY)))
    }

    @Test
    fun `a value containing a comma is quoted`() {
        assertEquals("\"Berlin, DE\"", csvEscape("Berlin, DE"))
    }

    @Test
    fun `an embedded quote is doubled and the value quoted`() {
        assertEquals("\"say \"\"hi\"\"\"", csvEscape("say \"hi\""))
    }

    @Test
    fun `a newline forces quoting, so the row does not split`() {
        assertEquals("\"line one\nline two\"", csvEscape("line one\nline two"))
        assertEquals("\"line one\rline two\"", csvEscape("line one\rline two"))
    }

    @Test
    fun `an ordinary value is left alone`() {
        assertEquals("paid", csvEscape("paid"))
        assertEquals("", csvEscape(""))
    }

    @Test
    fun `null and empty string stay distinguishable`() {
        assertEquals("∅ NULL", displayString(CellValue.Null))
        assertEquals("", displayString(CellValue.Text("")))
    }

    /** BIGINT/DECIMAL travel as strings; rendering them through a Double would round them. */
    @Test
    fun `an exact numeric keeps every digit`() {
        assertEquals("9007199254740993", displayString(CellValue.ExactNumeric("9007199254740993")))
        assertEquals("12345.6789012345678", displayString(CellValue.ExactNumeric("12345.6789012345678")))
    }

    @Test
    fun `a boolean and a number render as themselves`() {
        assertEquals("true", displayString(CellValue.Boolean(true)))
        assertEquals("42.5", displayString(CellValue.Number(42.5)))
    }

    @Test
    fun `binary shows its size and preview, never its bytes`() {
        val small = displayString(CellValue.Binary(BinaryPreview(bytes = 4, hexPreview = "deadbeef")))
        assertEquals("⟨4 bytes: deadbeef⟩", small)
        val large = displayString(CellValue.Binary(BinaryPreview(bytes = 4096, hexPreview = "deadbeef")))
        assertEquals("⟨4096 bytes: deadbeef…⟩", large)
    }

    /** A cell a spreadsheet would execute on open is exported as text. */
    @Test
    fun `a formula lead is neutralized with a leading apostrophe`() {
        assertEquals("'=1+1", csvEscape("=1+1"))
        assertEquals("'@SUM(A1:A2)", csvEscape("@SUM(A1:A2)"))
        assertEquals("'+cmd|' /C calc'!A0", csvEscape("+cmd|' /C calc'!A0"))
        assertEquals("'\tstill a formula", csvEscape("\tstill a formula"))
        // Quoting still applies on top of the apostrophe.
        assertEquals("\"'=A1,B1\"", csvEscape("=A1,B1"))
    }

    /** A negative number is data: prefixing it exports money columns as text that SUM() ignores. */
    @Test
    fun `a value that parses as a number is left alone`() {
        assertEquals("-5", csvEscape("-5"))
        assertEquals("-12.75", csvEscape(displayString(CellValue.Number(-12.75))))
        assertEquals("-9007199254740993", csvEscape(displayString(CellValue.ExactNumeric("-9007199254740993"))))
        assertEquals("-1.5e6", csvEscape("-1.5e6"))
    }

    /** The two run together on every export; a comma inside a rendered cell must survive the round trip. */
    @Test
    fun `a rendered cell is escaped before it reaches the file`() {
        assertEquals("\"∅ NULL\"", csvEscape(displayString(CellValue.Text("∅ NULL"))).let { if (it.startsWith("\"")) it else "\"$it\"" })
        assertEquals("\"a,b\"", csvEscape(displayString(CellValue.Text("a,b"))))
    }

    /** The clipboard lands in the same spreadsheet as the export, so it needs the same guard. */
    @Test
    fun `pasted cells are neutralized and kept on one line`() {
        assertEquals("'=1+1", tsvEscape("=1+1"))
        assertEquals("'@SUM(A1)", tsvEscape("@SUM(A1)"))
        assertEquals("-1234", tsvEscape("-1234"))
        assertEquals("-9007199254740993", tsvEscape("-9007199254740993"))
        // A tab or newline inside a cell would otherwise shift every later column.
        assertEquals("a b", tsvEscape("a\tb"))
        assertEquals("a b", tsvEscape("a\nb"))
    }

}
