package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.model.EngineKind
import org.junit.Assert.assertEquals
import org.junit.Test

/** [ConnectionDescriptor.target] is the display subtitle: file engines must show the file/in-memory, not a host:port they don't have. */
class ConnectionDescriptorTest {

    private fun d(engine: EngineKind, host: String? = null, port: Int? = null, database: String? = null, filePath: String? = null, connectionString: String? = null) =
        ConnectionDescriptor(id = "c", name = "c", engine = engine, scope = ConnectionScope.PROJECT, host = host, port = port, database = database, filePath = filePath, connectionString = connectionString)

    @Test fun `DuckDB with a file shows the file path, not a host`() {
        // The editor defaults host="localhost"; a file-based engine must still display the file.
        val target = d(EngineKind.DUCKDB, host = "localhost", filePath = "/data/warehouse.duckdb").target()
        assertEquals("/data/warehouse.duckdb", target)
    }

    @Test fun `DuckDB without a file shows in-memory, not localhost`() {
        assertEquals("in-memory", d(EngineKind.DUCKDB, host = "localhost", filePath = "").target())
        assertEquals("in-memory", d(EngineKind.DUCKDB, host = "localhost", filePath = null).target())
    }

    @Test fun `SQLite shows the file path`() {
        assertEquals("/tmp/app.db", d(EngineKind.SQLITE, host = "localhost", filePath = "/tmp/app.db").target())
    }

    @Test fun `a server engine still shows host colon port slash database`() {
        assertEquals("db.internal:5432/shop", d(EngineKind.POSTGRES, host = "db.internal", port = 5432, database = "shop").target())
    }

    @Test fun `MongoDB shows the connection string`() {
        assertEquals("mongodb://localhost:27017", d(EngineKind.MONGODB, connectionString = "mongodb://localhost:27017").target())
    }
}
