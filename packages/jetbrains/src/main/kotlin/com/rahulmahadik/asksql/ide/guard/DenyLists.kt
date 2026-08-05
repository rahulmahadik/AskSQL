package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.EngineKind

/**
 * Function-name deny lists ported verbatim from `@asksql/core`'s `guard.ts`. Each entry's
 * justification is preserved from the original; comments here summarize.
 */
object DenyLists {

    /** Postgres: server-state, file/dir disclosure, replication, locks, string-exec functions. */
    val PG_DENY_FUNCTIONS: List<String> = listOf(
        "pg_sleep", "pg_sleep_for", "pg_sleep_until",
        "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file",
        "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
        "pg_rotate_logfile", "pg_switch_wal", "pg_promote", "pg_create_restore_point",
        "pg_logical_emit_message", "pg_notify", "set_config",
        "dblink", "dblink_exec", "dblink_connect", "dblink_connect_u", "dblink_send_query",
        "dblink_open", "dblink_fetch", "dblink_close", "dblink_cancel_query", "dblink_get_result",
        // Large objects are writable server-side storage; read AND write are denied.
        "lo_import", "lo_export", "lo_put", "lo_from_bytea", "lo_unlink", "lo_creat",
        "lo_create", "lowrite", "loread", "lo_open", "lo_close", "lo_truncate", "lo_truncate64",
        "lo_lseek", "lo_lseek64", "lo_get", "lo_get_fragment", "lo_read",
        "pg_advisory_lock", "pg_advisory_lock_shared", "pg_advisory_xact_lock",
        "pg_advisory_xact_lock_shared", "pg_try_advisory_lock", "pg_try_advisory_lock_shared",
        "pg_try_advisory_xact_lock", "pg_try_advisory_xact_lock_shared",
        "pg_advisory_unlock", "pg_advisory_unlock_shared", "pg_advisory_unlock_all",
        "pg_create_logical_replication_slot", "pg_create_physical_replication_slot",
        "pg_drop_replication_slot", "pg_replication_origin_create", "pg_replication_origin_drop",
        "pg_replication_origin_session_setup", "pg_replication_origin_session_reset",
        "pg_replication_origin_advance", "pg_replication_origin_xact_setup", "pg_replication_origin_xact_reset",
        "pg_logical_slot_get_changes", "pg_logical_slot_get_binary_changes",
        "pg_stat_reset", "pg_stat_reset_shared", "pg_stat_reset_single_table_counters",
        "pg_stat_reset_single_function_counters", "pg_stat_reset_slru", "pg_stat_reset_replication_slot",
        "pg_export_snapshot", "pg_log_backend_memory_contexts",
        "pg_ls_logdir", "pg_ls_waldir", "pg_ls_tmpdir", "pg_ls_archive_statusdir",
        "pg_ls_replslotdir", "pg_ls_logicalsnapdir", "pg_ls_logicalmapdir", "pg_current_logfile",
        "pg_logdir_ls", "pg_read_server_files", "fsdir",
        "pg_file_write", "pg_file_unlink", "pg_file_rename", "pg_file_sync",
        "pg_start_backup", "pg_stop_backup", "pg_backup_start", "pg_backup_stop",
        "pg_wal_replay_pause", "pg_wal_replay_resume", "pg_replication_slot_advance",
        "pg_stat_statements_reset", "pg_import_system_collations",
        "gin_clean_pending_list", "brin_summarize_new_values", "brin_desummarize_range",
        "brin_summarize_range", "pgstattuple", "pgstatindex", "pgstatginindex",
        // Take SQL (or a whole table/schema/db) as a STRING and execute it; an AST check cannot see inside a string literal.
        "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema",
        "table_to_xml", "table_to_xmlschema", "table_to_xml_and_xmlschema",
        "cursor_to_xml", "cursor_to_xmlschema",
        "schema_to_xml", "schema_to_xmlschema", "schema_to_xml_and_xmlschema",
        "database_to_xml", "database_to_xmlschema", "database_to_xml_and_xmlschema",
        // Sequence mutation, denied on every dialect - DuckDB has no read-only session to block it.
        "nextval", "setval",
    )

    val MYSQL_DENY_FUNCTIONS: List<String> = listOf(
        "load_file", "sleep", "benchmark", "get_lock", "release_lock",
        "release_all_locks", "master_pos_wait", "source_pos_wait",
        "sys_exec", "sys_eval",
        "wait_for_executed_gtid_set", "wait_until_sql_thread_after_gtids",
    )

    val SQLITE_DENY_FUNCTIONS: List<String> = listOf(
        "load_extension", "readfile", "writefile", "edit", "fts3_tokenizer",
        "mkdir", "symlink", "lsdir", "fileio_read", "fileio_write", "zipfile",
    )

    /** DuckDB scanner/foreign-DB/secret/network functions denied on every dialect. */
    val DUCKDB_DENY_ALWAYS: List<String> = listOf(
        "getenv",
        "postgres_execute", "mysql_execute", "sqlite_execute",
        "postgres_query", "mysql_query", "sqlite_query",
        "postgres_scan", "postgres_scan_pushdown", "mysql_scan", "sqlite_scan",
        "postgres_attach", "mysql_attach", "sqlite_attach",
        "iceberg_scan", "iceberg_metadata", "iceberg_snapshots",
        "delta_scan", "ducklake_scan",
        "duckdb_secrets", "which_secret",
        "http_get", "http_post", "http_put", "http_delete", "http_head", "http_patch",
        "read_gsheet", "fsdir",
        "query", "query_table",
        "load_aws_credentials", "set_current_schema",
    )

    /** DuckDB function-name SUFFIXES that are always a foreign-DB/scanner escape. */
    val DUCKDB_DENY_SUFFIXES: List<String> = listOf("_execute", "_query", "_scan", "_attach")

    /** Postgres file/dir disclosure families; admin-only, never legitimate analytics. */
    val PG_DENY_PREFIXES: List<String> = listOf("pg_ls_", "pg_read_")

    /** DuckDB file/scan reader prefixes; closes the arbitrary-file-read class against future reader extensions too. */
    val DUCKDB_DENY_PREFIXES: List<String> = listOf("read_", "scan_")

    /** DuckDB-only: legitimate on Postgres, but discloses cloud credentials / makes outbound calls on DuckDB. */
    val DUCKDB_ONLY_DENY: List<String> = listOf("current_setting", "duckdb_settings", "prompt", "open_prompt")

    // Original to this plugin; no parity harness covers it.
    // Bare, unqualified SSRF constructors with no package prefix to catch them (Oracle's query_to_xml equivalent).
    val ORACLE_DENY_FUNCTIONS: List<String> = listOf("httpuritype", "dburitype", "xdburitype")

    /** Dangerous Oracle package prefixes, matched by [SqlGuard.checkDeniedFunctionName] against every schema-qualified form too (e.g. "sys.utl_file.fopen"). */
    val ORACLE_DENY_PREFIXES: List<String> = listOf(
        "utl_file.", // file I/O
        "utl_http.", "utl_tcp.", "utl_smtp.", "utl_inaddr.", "utl_dbws.", // network I/O / SSRF / exfiltration
        "urifactory.", // SYS.URIFACTORY.GETURI: same SSRF surface as the bare URITYPE constructors above
        "dbms_scheduler.", "dbms_job.", // schedules/executes arbitrary jobs
        "dbms_pipe.", // inter-session IPC
        "dbms_lock.", // includes DBMS_LOCK.SLEEP, Oracle's pg_sleep/SLEEP() equivalent
        "dbms_java.", // loads/executes Java code inside the database
        "dbms_sql.", // builds and executes arbitrary SQL text at runtime, invisible to this AST guard
        "dbms_xmlquery.", "dbms_xmlgen.", // can execute arbitrary query text / fetch URLs, like Postgres's query_to_xml family
        "dbms_metadata.", // blanket-denied for defense in depth; not needed for normal chat-to-SQL use
        "dbms_session.", // session mutation, including a SLEEP equivalent on newer versions
        "dbms_lob.", // LOB file I/O members (LOADFROMFILE, FILEOPEN, ...)
        "dbms_ldap.", "dbms_ldap_utl.", // network egress to an attacker-chosen host, same class as utl_http/utl_tcp above
    )

    /** File-reading table functions; denied unless [com.rahulmahadik.asksql.ide.model.GuardPolicy.allowFileFunctions]. */
    val DUCKDB_FILE_FUNCTIONS: List<String> = listOf(
        "read_csv", "read_csv_auto", "sniff_csv", "read_parquet", "parquet_scan",
        "read_json", "read_json_auto", "read_json_objects", "read_ndjson",
        "read_ndjson_auto", "read_text", "read_blob", "read_xlsx", "glob",
        "st_read", "st_readosm", "st_readshp", "st_read_meta",
        "parquet_metadata", "parquet_schema", "parquet_file_metadata", "parquet_kv_metadata",
        "read_json_objects_auto", "read_ndjson_objects",
    )

    private val UNIVERSAL_DENY: List<String> =
        PG_DENY_FUNCTIONS + MYSQL_DENY_FUNCTIONS + SQLITE_DENY_FUNCTIONS + DUCKDB_DENY_ALWAYS + ORACLE_DENY_FUNCTIONS

    /** Prefix analogue of [UNIVERSAL_DENY]: never real user functions, so denied on every dialect. DuckDB's read_/scan_ stay DuckDB-only. */
    private val UNIVERSAL_DENY_PREFIXES: List<String> = PG_DENY_PREFIXES + ORACLE_DENY_PREFIXES

    /** Defense in depth: every known-dangerous function is blocked on every dialect, not only its native one. */
    fun denySetFor(engine: EngineKind, policy: com.rahulmahadik.asksql.ide.model.GuardPolicy): Set<String> {
        val base = UNIVERSAL_DENY.toMutableSet()
        if (engine == EngineKind.DUCKDB && !policy.allowFileFunctions) {
            base += DUCKDB_FILE_FUNCTIONS
            base += DUCKDB_ONLY_DENY
        }
        base += policy.denyFunctions
        return base.map { it.lowercase() }.toSet()
    }

    fun denySuffixesFor(engine: EngineKind): List<String> =
        if (engine == EngineKind.DUCKDB) DUCKDB_DENY_SUFFIXES else emptyList()

    fun denyPrefixesFor(engine: EngineKind, policy: com.rahulmahadik.asksql.ide.model.GuardPolicy): List<String> = when {
        engine == EngineKind.DUCKDB && !policy.allowFileFunctions -> UNIVERSAL_DENY_PREFIXES + DUCKDB_DENY_PREFIXES
        else -> UNIVERSAL_DENY_PREFIXES
    }

    val SQLITE_PRAGMA_READ_ALLOWLIST: Set<String> = setOf(
        "table_info", "table_xinfo", "table_list", "index_list", "index_info",
        "index_xinfo", "foreign_key_list", "database_list", "function_list",
        "collation_list", "compile_options",
    )

    val MYSQL_SHOW_ALLOW: Regex = Regex(
        """^\s*show\s+(full\s+)?(tables|databases|schemas|columns|fields|index|indexes|keys|create\s+table|create\s+view|table\s+status|triggers|events|open\s+tables|status|variables|character\s+set|collation|engines|warnings|errors)\b""",
        RegexOption.IGNORE_CASE,
    )
}
