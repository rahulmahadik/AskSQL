package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.ColumnKind
import org.bson.Document
import org.bson.types.Binary
import org.bson.types.Decimal128
import org.bson.types.ObjectId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigDecimal
import java.util.Date

/** Exercises the pure BSON-to-[CellValue]/[ColumnKind] marshaling directly - no live MongoDB instance needed. */
class MongoQueryExecutorTest {

    @Test fun `null becomes CellValue Null`() {
        assertEquals(CellValue.Null, MongoQueryExecutor.cellValue(null))
    }

    @Test fun `int64 travels as an exact string, never a lossy double`() {
        val huge = 9_007_199_254_740_993L // one past the largest exactly-representable double integer
        val cell = MongoQueryExecutor.cellValue(huge)
        assertTrue(cell is CellValue.ExactNumeric)
        assertEquals("9007199254740993", (cell as CellValue.ExactNumeric).value)
        assertEquals(ColumnKind.BIGINT, MongoQueryExecutor.columnKind(huge))
    }

    @Test fun `decimal128 travels as an exact string`() {
        val decimal = Decimal128(BigDecimal("1234567890123456789012345.123456789")) // 34 significant digits - Decimal128's precision limit
        val cell = MongoQueryExecutor.cellValue(decimal)
        assertTrue(cell is CellValue.ExactNumeric)
        assertEquals(decimal.toString(), (cell as CellValue.ExactNumeric).value)
        assertEquals(ColumnKind.DECIMAL, MongoQueryExecutor.columnKind(decimal))
    }

    @Test fun `objectId becomes its hex string, not a lossy toString`() {
        val id = ObjectId()
        val cell = MongoQueryExecutor.cellValue(id)
        assertEquals(CellValue.Text(id.toHexString()), cell)
    }

    @Test fun `date becomes an ISO instant string`() {
        val date = Date()
        val cell = MongoQueryExecutor.cellValue(date)
        assertEquals(CellValue.Text(date.toInstant().toString()), cell)
        assertEquals(ColumnKind.TIMESTAMP, MongoQueryExecutor.columnKind(date))
    }

    @Test fun `binary becomes a size+hex preview, never the full byte array`() {
        val bytes = ByteArray(100) { it.toByte() }
        val cell = MongoQueryExecutor.cellValue(Binary(bytes))
        assertTrue(cell is CellValue.Binary)
        val preview = (cell as CellValue.Binary).preview
        assertEquals(100L, preview.bytes)
        assertEquals(64, preview.hexPreview.length) // 32 bytes capped, 2 hex chars each
    }

    @Test fun `nested document renders as readable JSON text with BSON types stripped`() {
        val doc = Document("city", "NYC").append("id", ObjectId("507f1f77bcf86cd799439011"))
        val cell = MongoQueryExecutor.cellValue(doc)
        assertTrue(cell is CellValue.Text)
        val text = (cell as CellValue.Text).value
        assertTrue(text.contains("NYC"))
        assertTrue("expected the ObjectId to render as its plain hex string, not an extended-JSON {\"\$oid\":...} wrapper", text.contains("507f1f77bcf86cd799439011"))
        assertTrue(!text.contains("\$oid"))
    }

    @Test fun `array of scalars renders as a plain JSON array`() {
        val cell = MongoQueryExecutor.cellValue(listOf("a", "b", "c"))
        assertEquals(CellValue.Text("[\"a\",\"b\",\"c\"]"), cell)
    }

    @Test fun `array of sub-documents renders every element`() {
        val cell = MongoQueryExecutor.cellValue(listOf(Document("sku", "X1"), Document("sku", "X2")))
        assertTrue(cell is CellValue.Text)
        val text = (cell as CellValue.Text).value
        assertTrue(text.contains("X1"))
        assertTrue(text.contains("X2"))
    }

    @Test fun `int32 and double are treated as ordinary numbers, not exact-numeric`() {
        assertEquals(CellValue.Number(42.0), MongoQueryExecutor.cellValue(42))
        assertEquals(CellValue.Number(3.5), MongoQueryExecutor.cellValue(3.5))
        assertEquals(ColumnKind.NUMBER, MongoQueryExecutor.columnKind(42))
        assertEquals(ColumnKind.NUMBER, MongoQueryExecutor.columnKind(3.5))
    }
}
