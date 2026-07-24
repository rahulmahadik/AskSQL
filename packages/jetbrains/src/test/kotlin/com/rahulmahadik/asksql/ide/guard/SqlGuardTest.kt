package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.GuardPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Security-property tests for [SqlGuard], drawn from the threat classes documented in `@asksql/core`'s `guard.ts`. Not exhaustive fuzzing (see `tools/parity/`); locks in the guard's core promises. */
class SqlGuardTest {

    private fun guard(sql: String, engine: com.rahulmahadik.asksql.ide.model.DialectInfo = Dialects.POSTGRES, policy: GuardPolicy = GuardPolicy.DEFAULT) =
        SqlGuard.guard(sql, engine, policy)

    // ---- Basic allow / deny shape ----

    @Test fun `allows a simple select`() {
        val v = guard("SELECT id, name FROM users")
        assertTrue(v.allowed)
        assertTrue("expected auto-LIMIT to be appended", v.sql.contains("LIMIT"))
    }

    @Test fun `allows a quoted call to a function that is not denied`() {
        // Quote-stripping normalization must not treat quoting itself as
        // suspicious; only denied names are affected.
        assertTrue(guard("""SELECT "upper"('x')""").allowed)
    }

    @Test fun `a bare OFFSET is not read as a LIMIT - auto-LIMIT still applies and OFFSET is preserved`() {
        val v = guard("SELECT * FROM users OFFSET 5000", policy = GuardPolicy.DEFAULT.copy(maxRows = 1000))
        assertTrue(v.allowed)
        assertTrue("expected auto-LIMIT despite the OFFSET", v.autoLimited)
        assertFalse("OFFSET is not a too-high LIMIT", v.loweredLimit)
        assertTrue("OFFSET must survive untouched", v.sql.contains("5000"))
        assertTrue(v.sql.uppercase().contains("LIMIT 1000"))
    }

    @Test fun `blocks insert`() {
        assertFalse(guard("INSERT INTO users (name) VALUES ('x')").allowed)
    }

    @Test fun `blocks update`() {
        assertFalse(guard("UPDATE users SET name = 'x' WHERE id = 1").allowed)
    }

    @Test fun `blocks delete`() {
        assertFalse(guard("DELETE FROM users WHERE id = 1").allowed)
    }

    @Test fun `blocks drop table`() {
        assertFalse(guard("DROP TABLE users").allowed)
    }

    @Test fun `blocks create table`() {
        assertFalse(guard("CREATE TABLE evil (id int)").allowed)
    }

    @Test fun `blocks truncate`() {
        assertFalse(guard("TRUNCATE users").allowed)
    }

    @Test fun `blocks empty statement`() {
        val v = guard("   ")
        assertFalse(v.allowed)
        assertEquals("empty", v.ruleId)
    }

    @Test fun `blocks unparseable garbage fail-closed`() {
        assertFalse(guard("SELEC WAT FROM ((( unmatched").allowed)
    }

    @Test fun `blocks a pathologically deeply nested statement without crashing`() {
        val deep = "SELECT * FROM t WHERE " + "(".repeat(20_000) + "1=1" + ")".repeat(20_000)
        assertFalse(guard(deep).allowed)
    }

    // ---- Multi-statement / comment smuggling ----

    @Test fun `blocks multiple statements`() {
        assertFalse(guard("SELECT 1; DROP TABLE users;").allowed)
    }

    @Test fun `blocks a write hidden after a line comment is stripped`() {
        // The comment strip must not accidentally delete the semicolon check target.
        assertFalse(guard("SELECT 1; -- innocuous\nDROP TABLE users").allowed)
    }

    @Test fun `blocks mysql executable comment smuggling`() {
        val mysql = Dialects.MYSQL
        assertFalse(guard("SELECT 1 /*!50000,(SELECT sleep(5))*/", mysql).allowed)
    }

    // ---- CTEs ----

    @Test fun `allows a read-only CTE`() {
        val v = guard("WITH recent AS (SELECT id FROM orders WHERE created_at > now() - interval '1 day') SELECT * FROM recent")
        assertTrue(v.allowed)
    }

    // ---- Dangerous functions ----

    @Test fun `blocks pg_sleep`() {
        assertFalse(guard("SELECT pg_sleep(10)").allowed)
    }

    // ---- Quoted-identifier deny-list bypass ----
    // JSqlParser's Function.getName() keeps the literal quote characters, so names are
    // unquoted before matching; otherwise a quoted call would sail past every entry.

    @Test fun `blocks a double-quoted denied function name on postgres`() {
        assertFalse(guard("""SELECT "pg_read_file"('/etc/passwd')""").allowed)
    }

    @Test fun `blocks a double-quoted pg_sleep`() {
        assertFalse(guard("""SELECT "pg_sleep"(10)""").allowed)
    }

    @Test fun `blocks a backtick-quoted denied function name on mysql`() {
        assertFalse(guard("SELECT `load_file`('/etc/passwd')", Dialects.MYSQL).allowed)
    }

    @Test fun `blocks a backtick-quoted sleep on mysql`() {
        assertFalse(guard("SELECT `sleep`(5)", Dialects.MYSQL).allowed)
    }

    @Test fun `blocks a double-quoted prefix-denied function on postgres`() {
        assertFalse(guard("""SELECT "pg_ls_dir"('/tmp')""").allowed)
    }

    @Test fun `blocks a double-quoted read_csv on duckdb`() {
        assertFalse(guard("""SELECT * FROM "read_csv"('/etc/passwd')""", Dialects.DUCKDB).allowed)
    }

    @Test fun `blocks dblink`() {
        assertFalse(guard("SELECT * FROM dblink('host=evil.example', 'SELECT 1') AS t(x int)").allowed)
    }

    @Test fun `blocks a denied function hidden in LIMIT`() {
        assertFalse(guard("SELECT * FROM t LIMIT pg_sleep(1)").allowed)
    }

    @Test fun `blocks a denied function hidden in OFFSET`() {
        assertFalse(guard("SELECT * FROM t LIMIT 10 OFFSET pg_sleep(1)").allowed)
    }

    @Test fun `blocks a denied function hidden in DISTINCT ON`() {
        assertFalse(guard("SELECT DISTINCT ON (pg_sleep(1)) * FROM t").allowed)
    }

    @Test fun `blocks dblink hidden in DISTINCT ON`() {
        assertFalse(guard("SELECT DISTINCT ON (dblink('host=evil.example dbname=x', 'select 1')) col FROM t").allowed)
    }

    @Test fun `allows an ordinary Postgres DISTINCT ON query`() {
        assertTrue(guard("SELECT DISTINCT ON (customer_id) customer_id, total FROM orders ORDER BY customer_id, total DESC").allowed)
    }

    @Test fun `allows a plain SELECT DISTINCT`() {
        assertTrue(guard("SELECT DISTINCT country FROM customers").allowed)
    }

    @Test fun `blocks query_to_xml string-exec wrapper`() {
        assertFalse(guard("SELECT query_to_xml('SELECT pg_sleep(60)', true, false, '')").allowed)
    }

    @Test fun `blocks load_file on mysql`() {
        assertFalse(guard("SELECT load_file('/etc/passwd')", Dialects.MYSQL).allowed)
    }

    @Test fun `blocks sleep on mysql`() {
        assertFalse(guard("SELECT sleep(5)", Dialects.MYSQL).allowed)
    }

    @Test fun `blocks load_extension on sqlite`() {
        assertFalse(guard("SELECT load_extension('/tmp/evil.so')", Dialects.SQLITE).allowed)
    }

    @Test fun `blocks duckdb http_get ssrf`() {
        assertFalse(guard("SELECT http_get('http://169.254.169.254/latest/meta-data/')", Dialects.DUCKDB).allowed)
    }

    @Test fun `blocks duckdb read_csv by default`() {
        assertFalse(guard("SELECT * FROM read_csv('/etc/passwd')", Dialects.DUCKDB).allowed)
    }

    @Test fun `allows duckdb read_csv when policy opts in`() {
        val v = guard("SELECT * FROM read_csv('data.csv')", Dialects.DUCKDB, GuardPolicy(allowFileFunctions = true))
        assertTrue(v.allowed)
    }

    @Test fun `blocks cross-dialect dangerous function even on a different engine`() {
        // pg_sleep is Postgres-specific, but the universal deny set blocks it everywhere as defense in depth.
        assertFalse(guard("SELECT pg_sleep(1)", Dialects.DUCKDB).allowed)
    }

    @Test fun `blocks duckdb ATTACH of another database file`() {
        assertFalse(guard("ATTACH 'evil.duckdb' AS other", Dialects.DUCKDB).allowed)
    }

    @Test fun `blocks duckdb COPY TO writing a file`() {
        assertFalse(guard("COPY (SELECT 1) TO 'out.csv'", Dialects.DUCKDB).allowed)
    }

    @Test fun `blocks duckdb EXPORT DATABASE`() {
        assertFalse(guard("EXPORT DATABASE 'out_dir'", Dialects.DUCKDB).allowed)
    }

    // ---- File/URL relation smuggling (DuckDB replacement scan) ----

    @Test fun `blocks a bare file path used as a table`() {
        assertFalse(guard("SELECT * FROM '/etc/passwd.csv'", Dialects.DUCKDB).allowed)
    }

    @Test fun `blocks an http url used as a table`() {
        assertFalse(guard("SELECT * FROM 'http://evil.example/data.parquet'", Dialects.DUCKDB).allowed)
    }

    // ---- Locking / write-adjacent clauses ----

    @Test fun `blocks select for update`() {
        assertFalse(guard("SELECT * FROM accounts WHERE id = 1 FOR UPDATE").allowed)
    }

    @Test fun `blocks select for update with a comment obfuscating the keyword`() {
        assertFalse(guard("SELECT * FROM accounts LIMIT 5 FOR/**/UPDATE").allowed)
    }

    @Test fun `blocks select into`() {
        assertFalse(guard("SELECT * INTO new_table FROM accounts").allowed)
    }

    @Test fun `blocks into outfile`() {
        assertFalse(guard("SELECT * FROM accounts INTO OUTFILE '/tmp/dump.csv'", Dialects.MYSQL).allowed)
    }

    // ---- Oracle ----
    // No upstream `@asksql/core` counterpart exists for Oracle (see
    // Dialects.ORACLE), so (unlike every block above) none of this is    // replayed against a parity corpus; it is this plugin's only safety net
    // for Oracle's threat surface.

    @Test fun `allows a simple oracle select from dual`() {
        val v = guard("SELECT 1 FROM DUAL", Dialects.ORACLE)
        assertTrue(v.allowed)
    }

    @Test fun `injects FETCH FIRST, not LIMIT, for oracle`() {
        val v = guard("SELECT * FROM employees", Dialects.ORACLE)
        assertTrue(v.allowed)
        assertTrue("expected FETCH FIRST, not LIMIT, in auto-capped oracle SQL", v.sql.contains("FETCH FIRST"))
        assertFalse(v.sql.contains("LIMIT"))
    }

    @Test fun `lowers an excessive literal FETCH FIRST on oracle`() {
        val v = guard("SELECT * FROM employees FETCH FIRST 999999 ROWS ONLY", Dialects.ORACLE, GuardPolicy(maxRows = 100))
        assertTrue(v.allowed)
        assertTrue(v.loweredLimit)
    }

    @Test fun `allows connect by hierarchical queries on oracle`() {
        val v = guard("SELECT empno FROM emp START WITH mgr IS NULL CONNECT BY PRIOR empno = mgr", Dialects.ORACLE)
        assertTrue(v.allowed)
    }

    @Test fun `allows the legacy outer join operator on oracle`() {
        val v = guard("SELECT * FROM a, b WHERE a.id = b.id(+)", Dialects.ORACLE)
        assertTrue(v.allowed)
    }

    @Test fun `blocks utl_file file IO on oracle`() {
        assertFalse(guard("SELECT utl_file.fopen('DIR', 'f.txt', 'r') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks utl_http network calls on oracle`() {
        assertFalse(guard("SELECT utl_http.request('http://169.254.169.254/latest/meta-data/') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks utl_inaddr dns resolution on oracle`() {
        assertFalse(guard("SELECT utl_inaddr.get_host_address('evil.example') FROM dual", Dialects.ORACLE).allowed)
    }

    // ---- Schema-qualified / quoted Oracle package calls ----
    // "SYS.UTL_HTTP.REQUEST" pushes the package name out of segment 0, and
    // '"UTL_HTTP"."REQUEST"' keeps literal quote characters in getName(); both must still be
    // caught by the prefix check despite the qualifier and the quoting.

    @Test fun `blocks a schema-qualified utl_http call on oracle`() {
        assertFalse(guard("SELECT SYS.UTL_HTTP.REQUEST('http://evil.example') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks a double-quoted schema-qualified utl_http call on oracle`() {
        assertFalse(guard("""SELECT "UTL_HTTP"."REQUEST"('http://evil.example') FROM dual""", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks a double-quoted utl_file call on oracle`() {
        assertFalse(guard("""SELECT "UTL_FILE"."FOPEN"('DIR', 'f.txt', 'r') FROM dual""", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks httpuritype ssrf constructor on oracle`() {
        assertFalse(guard("SELECT HTTPURITYPE('http://evil.example').getclob() FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dburitype on oracle`() {
        assertFalse(guard("SELECT DBURITYPE('http://evil.example').getclob() FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks xdburitype on oracle`() {
        assertFalse(guard("SELECT XDBURITYPE('http://evil.example').getBlob() FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks a schema-qualified urifactory call on oracle`() {
        assertFalse(guard("SELECT SYS.URIFACTORY.GETURI('http://evil.example') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_ldap network egress on oracle`() {
        assertFalse(guard("SELECT DBMS_LDAP.INIT('evil.example', 389) FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_scheduler job creation on oracle`() {
        assertFalse(guard("SELECT dbms_scheduler.create_job('j', 'PLSQL_BLOCK', 'NULL;') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_lock sleep on oracle`() {
        assertFalse(guard("SELECT dbms_lock.sleep(10) FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_sql dynamic sql on oracle`() {
        assertFalse(guard("SELECT dbms_sql.open_cursor() FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_java on oracle`() {
        assertFalse(guard("SELECT dbms_java.runjava('evil') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_pipe ipc on oracle`() {
        assertFalse(guard("SELECT dbms_pipe.pack_message('x') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_lob file IO on oracle`() {
        assertFalse(guard("SELECT dbms_lob.loadfromfile(a, b, 1) FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_xmlgen on oracle`() {
        assertFalse(guard("SELECT dbms_xmlgen.getxml('SELECT pg_sleep(60)') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_metadata on oracle`() {
        assertFalse(guard("SELECT dbms_metadata.get_ddl('TABLE', 'EMP') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks dbms_session on oracle`() {
        assertFalse(guard("SELECT dbms_session.set_role('x') FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks nextval sequence advancement on oracle`() {
        assertFalse(guard("SELECT my_seq.NEXTVAL FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `blocks currval sequence read on oracle`() {
        assertFalse(guard("SELECT my_seq.CURRVAL FROM dual", Dialects.ORACLE).allowed)
    }

    @Test fun `nextval is only special-cased on oracle, not other engines`() {
        // A column named exactly "nextval" is implausible elsewhere, but this
        // guards the engine-gating itself: the check must not fire for non-Oracle dialects.
        val v = guard("SELECT nextval FROM some_table", Dialects.POSTGRES)
        assertTrue(v.allowed)
    }

    @Test fun `blocks cross-dialect dangerous function even when run against oracle`() {
        assertFalse(guard("SELECT pg_sleep(1) FROM dual", Dialects.ORACLE).allowed)
    }

    // ---- Dialect-specific allowlisted read commands ----

    @Test fun `allows sqlite table_info pragma`() {
        val v = guard("PRAGMA table_info(users)", Dialects.SQLITE)
        assertTrue(v.allowed)
    }

    @Test fun `blocks a non-allowlisted sqlite pragma`() {
        assertFalse(guard("PRAGMA journal_mode = WAL", Dialects.SQLITE).allowed)
    }

    @Test fun `allows mysql show tables`() {
        assertTrue(guard("SHOW TABLES", Dialects.MYSQL).allowed)
    }

    // ---- EXPLAIN ----

    @Test fun `allows explain of a guarded select`() {
        val v = guard("EXPLAIN SELECT * FROM users")
        assertTrue(v.allowed)
    }

    @Test fun `blocks explain of a write statement`() {
        assertFalse(guard("EXPLAIN DELETE FROM users").allowed)
    }

    // ---- Row cap ----

    @Test fun `lowers an excessive literal limit`() {
        val v = guard("SELECT * FROM users LIMIT 999999", policy = GuardPolicy(maxRows = 100))
        assertTrue(v.allowed)
        assertTrue(v.loweredLimit)
    }

    @Test fun `does not touch a limit already within policy`() {
        val v = guard("SELECT * FROM users LIMIT 10", policy = GuardPolicy(maxRows = 1000))
        assertTrue(v.allowed)
        assertFalse(v.autoLimited)
        assertFalse(v.loweredLimit)
    }

    // ---- Writable CTE (JSqlParser 5.x's WithItem can carry a writable body) ----

    @Test fun `blocks a writable CTE body`() {
        val v = guard("WITH x AS (INSERT INTO t (a) VALUES (1) RETURNING *) SELECT * FROM x")
        assertFalse(v.allowed)
        assertEquals("writable_cte", v.ruleId)
    }

    // ---- Length cap ----

    @Test fun `blocks a statement exceeding maxSqlLength`() {
        val v = guard("SELECT * FROM users WHERE id = 1", policy = GuardPolicy(maxSqlLength = 10))
        assertFalse(v.allowed)
        assertEquals("too_long", v.ruleId)
    }

    // ---- Non-literal LIMIT ----

    @Test fun `warns instead of blocking on a non-literal limit`() {
        val v = guard("SELECT * FROM users LIMIT ?")
        assertTrue(v.allowed)
        assertFalse(v.autoLimited)
        assertFalse(v.loweredLimit)
        assertTrue("expected a non-literal-limit warning", v.warnings.any { it.contains("non-literal") })
    }

    // ---- MySQL DESCRIBE ----

    @Test fun `allows mysql describe of a single table`() {
        val v = guard("DESCRIBE users", Dialects.MYSQL)
        assertTrue(v.allowed)
    }

    @Test fun `allows mysql desc shorthand of a single table`() {
        val v = guard("DESC users", Dialects.MYSQL)
        assertTrue(v.allowed)
    }

    // ---- UNION / SetOperationList ----

    @Test fun `blocks a denied function hidden in a non-final UNION branch`() {
        assertFalse(guard("SELECT pg_sleep(1) FROM t UNION SELECT 1").allowed)
    }

    @Test fun `auto-LIMIT is driven by the last SELECT of a UNION, ignoring an earlier branch's own limit`() {
        val v = guard("(SELECT id FROM a LIMIT 5) UNION (SELECT id FROM b)", policy = GuardPolicy(maxRows = 100))
        assertTrue(v.allowed)
        assertTrue("expected the auto-LIMIT to be appended since the LAST select has no limit of its own", v.autoLimited)
    }

    @Test fun `a high literal limit on the last UNION branch is lowered, not one on an earlier branch`() {
        // The last branch is left unparenthesized so its trailing LIMIT
        // attaches directly to its own PlainSelect node (matching how
        // effectiveLimitTarget locates it), not wrapped in a ParenthesedSelect.
        val v = guard("(SELECT id FROM a LIMIT 5) UNION SELECT id FROM b LIMIT 999999", policy = GuardPolicy(maxRows = 100))
        assertTrue(v.allowed)
        assertTrue("expected the LAST select's own excessive limit to be lowered", v.loweredLimit)
    }

    // ---- policy.denyFunctions extensibility hook ----

    @Test fun `blocks a caller-supplied denied function name`() {
        val v = guard("SELECT custom_evil_func(1)", policy = GuardPolicy(denyFunctions = setOf("custom_evil_func")))
        assertFalse(v.allowed)
        assertEquals("function_denied:custom_evil_func", v.ruleId)
    }

    // ---- VALUES(...): a denied function called from inside a row-constructor must be caught on every walk path ----

    @Test fun `blocks a denied function called at the top level of a VALUES statement`() {
        val v = guard("VALUES (pg_sleep(1))")
        assertFalse(v.allowed)
        assertEquals("function_denied:pg_sleep", v.ruleId)
    }

    @Test fun `blocks a denied function called inside a VALUES used as a FROM item`() {
        val v = guard("SELECT * FROM (VALUES (pg_sleep(1))) AS v(x)")
        assertFalse(v.allowed)
        assertEquals("function_denied:pg_sleep", v.ruleId)
    }

    @Test fun `blocks a denied function called inside a VALUES used as a JOIN item`() {
        val v = guard("SELECT * FROM users JOIN (VALUES (pg_sleep(1))) AS v(x) ON true")
        assertFalse(v.allowed)
        assertEquals("function_denied:pg_sleep", v.ruleId)
    }

    @Test fun `blocks a denied function called inside an IN VALUES row-constructor`() {
        val v = guard("SELECT 1 FROM users WHERE id IN (VALUES (pg_sleep(1)))")
        assertFalse(v.allowed)
        assertEquals("function_denied:pg_sleep", v.ruleId)
    }

    @Test fun `blocks a denied function inside a multi-row VALUES, even in a later row`() {
        val v = guard("SELECT * FROM (VALUES (1), (pg_sleep(1))) AS v(x)")
        assertFalse(v.allowed)
        assertEquals("function_denied:pg_sleep", v.ruleId)
    }

    @Test fun `allows a VALUES statement containing only literals`() {
        val v = guard("SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS v(id, label)")
        assertTrue(v.allowed)
    }

    // ---- Subquery expressions (scalar / IN / EXISTS); a Select subtype reached via
    // Expression.accept() always statically dispatches to visit(Select, S), never a
    // subtype-specific overload, so a visit(ParenthesedSelect, S) override would be dead
    // code; each of these must be reached through visit(Select, S). ----

    @Test fun `blocks a denied function inside a scalar subquery`() {
        val v = guard("SELECT (SELECT pg_sleep(1))")
        assertFalse(v.allowed)
        assertEquals("function_denied:pg_sleep", v.ruleId)
    }

    @Test fun `blocks a denied function inside an IN SELECT subquery`() {
        val v = guard("SELECT 1 FROM users WHERE id IN (SELECT pg_sleep(1))")
        assertFalse(v.allowed)
        assertEquals("function_denied:pg_sleep", v.ruleId)
    }

    @Test fun `blocks a denied function inside an EXISTS subquery`() {
        val v = guard("SELECT 1 FROM users WHERE EXISTS (SELECT pg_sleep(1))")
        assertFalse(v.allowed)
        assertEquals("function_denied:pg_sleep", v.ruleId)
    }

    @Test fun `blocks a denied function inside a subquery used as a FROM item`() {
        val v = guard("SELECT * FROM (SELECT pg_sleep(1) AS x) sub")
        assertFalse(v.allowed)
        assertEquals("function_denied:pg_sleep", v.ruleId)
    }

    @Test fun `allows a legitimate scalar subquery with no denied function`() {
        val v = guard("SELECT (SELECT count(*) FROM users)")
        assertTrue(v.allowed)
    }

    @Test fun `allows a legitimate IN SELECT subquery with no denied function`() {
        val v = guard("SELECT 1 FROM users WHERE id IN (SELECT id FROM orders)")
        assertTrue(v.allowed)
    }

    // ---- Cross-dialect prefix denial (defense in depth for a mis-set dialect) ----

    @Test fun `blocks oracle utl_file prefix under a non-oracle dialect`() {
        assertFalse(guard("SELECT UTL_FILE.FOPEN('D','f','w') FROM t", Dialects.POSTGRES).allowed)
        assertFalse(guard("SELECT UTL_FILE.FOPEN('D','f','w') FROM t", Dialects.MYSQL).allowed)
        assertFalse(guard("SELECT UTL_FILE.FOPEN('D','f','w') FROM t", Dialects.SQLITE).allowed)
    }

    @Test fun `blocks postgres pg_read_file prefix under a non-postgres dialect`() {
        assertFalse(guard("SELECT pg_read_file('/etc/passwd')", Dialects.ORACLE).allowed)
        assertFalse(guard("SELECT pg_ls_dir('/')", Dialects.MYSQL).allowed)
    }

    @Test fun `does not over-block a column or table that merely starts with a prefix word`() {
        assertTrue(guard("SELECT read_count, scan_id FROM utl_readings", Dialects.POSTGRES).allowed)
    }
}
