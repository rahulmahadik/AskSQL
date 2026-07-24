package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure logic tests for [DuckDbFileLoader] (format sniffing, name sanitization, path safety, dump
 * validation); real load-through-a-connection behavior is covered by `DuckDbFileLoadTest`.
 */
class DuckDbFileLoaderTest {

    // ---- Format resolution ----

    @Test fun `resolves format by file extension`() {
        assertEquals(DuckDbFileLoader.FileFormat.CSV, DuckDbFileLoader.resolveFormat("data.csv"))
        assertEquals(DuckDbFileLoader.FileFormat.JSON, DuckDbFileLoader.resolveFormat("data.json"))
        assertEquals(DuckDbFileLoader.FileFormat.NDJSON, DuckDbFileLoader.resolveFormat("data.ndjson"))
        assertEquals(DuckDbFileLoader.FileFormat.PARQUET, DuckDbFileLoader.resolveFormat("data.parquet"))
        assertEquals(DuckDbFileLoader.FileFormat.XLSX, DuckDbFileLoader.resolveFormat("data.xlsx"))
        assertEquals(DuckDbFileLoader.FileFormat.XLSX, DuckDbFileLoader.resolveFormat("data.xls"))
        assertEquals(DuckDbFileLoader.FileFormat.SQL, DuckDbFileLoader.resolveFormat("dump.sql"))
    }

    @Test fun `an unrecognized extension falls back to CSV`() {
        assertEquals(DuckDbFileLoader.FileFormat.CSV, DuckDbFileLoader.resolveFormat("data.txt"))
        assertEquals(DuckDbFileLoader.FileFormat.CSV, DuckDbFileLoader.resolveFormat("data"))
    }

    @Test fun `format resolution is case-insensitive`() {
        assertEquals(DuckDbFileLoader.FileFormat.PARQUET, DuckDbFileLoader.resolveFormat("DATA.PARQUET"))
    }

    // ---- Table-name sanitization ----

    @Test fun `sanitizes special characters to underscores`() {
        assertEquals("my_report_2024", DuckDbFileLoader.sanitizeTableName("my-report 2024.csv"))
    }

    @Test fun `prefixes a name that starts with a digit`() {
        assertEquals("t_2024_data", DuckDbFileLoader.sanitizeTableName("2024_data.csv"))
    }

    @Test fun `a reserved SQL keyword gets a _data suffix, preserving the original case`() {
        // Matches the ported reference exactly: the reserved-word CHECK is
        // case-insensitive, but the suffix is appended to the original,
        // not the lowercased, string.
        assertEquals("select_data", DuckDbFileLoader.sanitizeTableName("select.csv"))
        assertEquals("ORDER_data", DuckDbFileLoader.sanitizeTableName("ORDER.csv"))
    }

    @Test fun `a name with no usable characters still gets the t_ prefix, never truly empty`() {
        assertEquals("t_", DuckDbFileLoader.sanitizeTableName(".csv"))
    }

    // ---- Path safety ----

    @Test fun `rejects a remote URL path by default`() {
        val ex = assertThrows(AskSqlException::class.java) { DuckDbFileLoader.assertSafeFilePath("http://example.com/data.csv") }
        assertEquals(AskSqlErrorCode.FILE_LOAD_ERROR, ex.code)
    }

    @Test fun `allows a remote URL path when explicitly permitted`() {
        DuckDbFileLoader.assertSafeFilePath("http://example.com/data.csv", allowRemote = true) // must not throw
    }

    @Test fun `rejects a glob pattern by default`() {
        val ex = assertThrows(AskSqlException::class.java) { DuckDbFileLoader.assertSafeFilePath("/data/*.csv") }
        assertEquals(AskSqlErrorCode.FILE_LOAD_ERROR, ex.code)
    }

    @Test fun `allows an ordinary local path`() {
        DuckDbFileLoader.assertSafeFilePath("/Users/me/data.csv") // must not throw
    }

    // ---- .sql dump validation ----

    @Test fun `allows a plain CREATE TABLE and INSERT dump`() {
        DuckDbFileLoader.validateSqlDump("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);") // must not throw
    }

    @Test fun `rejects a mysqldump-style dump with backticks`() {
        val ex = assertThrows(AskSqlException::class.java) { DuckDbFileLoader.validateSqlDump("CREATE TABLE `t` (id int);") }
        assertEquals(AskSqlErrorCode.FILE_LOAD_ERROR, ex.code)
        assertTrue(ex.userMessage.contains("MySQL"))
    }

    @Test fun `rejects a mysqldump-style dump with an ENGINE clause`() {
        val ex = assertThrows(AskSqlException::class.java) {
            DuckDbFileLoader.validateSqlDump("CREATE TABLE t (id int) ENGINE=InnoDB;")
        }
        assertEquals(AskSqlErrorCode.FILE_LOAD_ERROR, ex.code)
    }

    @Test fun `rejects a pg_dump-style dump with COPY FROM stdin`() {
        val ex = assertThrows(AskSqlException::class.java) {
            DuckDbFileLoader.validateSqlDump("COPY t (id) FROM stdin;\n1\n\\.\n")
        }
        assertEquals(AskSqlErrorCode.FILE_LOAD_ERROR, ex.code)
        assertTrue(ex.userMessage.contains("PostgreSQL"))
    }

    @Test fun `rejects ATTACH`() {
        val ex = assertThrows(AskSqlException::class.java) { DuckDbFileLoader.validateSqlDump("ATTACH '/etc/passwd' AS x;") }
        assertEquals(AskSqlErrorCode.FILE_LOAD_ERROR, ex.code)
    }

    @Test fun `rejects a file-reading table function`() {
        val ex = assertThrows(AskSqlException::class.java) {
            DuckDbFileLoader.validateSqlDump("CREATE TABLE t AS SELECT * FROM read_csv('/etc/passwd');")
        }
        assertEquals(AskSqlErrorCode.FILE_LOAD_ERROR, ex.code)
    }
}
