package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.JdbcExecutor
import com.rahulmahadik.asksql.ide.db.introspect.Introspectors
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.guard.SqlGuard
import com.rahulmahadik.asksql.ide.llm.LlmClient
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.EngineEvent
import com.rahulmahadik.asksql.ide.model.EngineEventListener
import com.rahulmahadik.asksql.ide.model.GuardPolicy
import com.rahulmahadik.asksql.ide.model.GuardVerdict
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.Stage
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.util.withHardTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Duration.Companion.seconds

/**
 * One pipeline for the whole plugin, keeping `@asksql/core`'s `engine.ts` invariants: guard every
 * SQL string before every execution, and never hold a DB connection open across an LLM call.
 */
class EnginePipeline(
    private val connectionRegistry: ConnectionRegistry,
    private val history: HistoryStore = InMemoryHistoryStore(),
    /** A `var`, not a `val`: a `maxRows` change must apply on the next question, so [com.rahulmahadik.asksql.ide.AskSqlEngineService] refreshes this on every access. */
    var policy: GuardPolicy = GuardPolicy.DEFAULT,
    /** Schema token budget, refreshed from settings on every access like [policy]. */
    var maxSchemaTokens: Int = CatalogPruner.PrunerSettings().maxSchemaTokens,
) {
    companion object {
        private const val MAX_REPAIRS = 2
        private val CATALOG_TTL = 300.seconds
        private const val DEFAULT_QUERY_TIMEOUT_MS = 30_000L

        /** "SELECT 'canned reply' AS x" with no FROM - a model faking conversation as data. */
        private val LITERAL_STRING_ANSWER_RE = Regex(
            """^select\s+'(?:[^']|'')*'\s*(?:as\s+\w+)?\s*(?:limit\s+\d+)?\s*;?\s*$""",
            RegexOption.IGNORE_CASE,
        )

        /** Questions about the database's own structure rather than its rows. */
        private val METADATA_INTENT_RE = Regex(
            """\b(show|list|display|describe|enumerate|count|name|get|give|tell|see|view|what(?:'s| is| are)?|which|how many|do (?:you|we) have|are there|exist)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val METADATA_OBJECT_RE = Regex(
            """\b(tables?|collections?|columns?|fields?|schemas?|views?|indexes|indices|relationships?|foreign keys?|primary keys?|(?:database|db|data) (?:structure|layout|schema))\b""",
            RegexOption.IGNORE_CASE,
        )

        internal fun isMetadataQuestion(question: String) =
            METADATA_INTENT_RE.containsMatchIn(question) && METADATA_OBJECT_RE.containsMatchIn(question)

        /** A request to add/change/remove schema objects rather than understand the current schema. */
        private val SCHEMA_CHANGE_RE = Regex("""\b(add|create|extend|alter|drop|remove|rename|migrate|introduce|modify)\b""", RegexOption.IGNORE_CASE)

        /** A whole-schema question (relationships, overview, table count) that needs the full picture, not a term-pruned handful of tables. */
        private val BROAD_SCHEMA_RE =
            Regex("""\b(?:relat|overview|summar|structur|entit|connect|erd|diagram)\w*|how many tables?|all (?:the )?tables?|whole (?:schema|database)|about (?:this|the|my) (?:database|schema|db)|what.{0,20}(?:database|schema|db) (?:is|for|about|do)""", RegexOption.IGNORE_CASE)

        // SQL vocabulary and types that read like identifiers but never name a table or column.
        private val NON_IDENTIFIER_SNAKE = setOf(
            "primary_key", "foreign_key", "foreign_keys", "data_type", "data_types",
            "not_null", "auto_increment", "use_case", "read_only", "read_write",
            "integer", "int", "bigint", "smallint", "serial", "bigserial", "varchar", "char", "text",
            "boolean", "bool", "date", "time", "timestamp", "timestamptz", "numeric", "decimal", "real",
            "uuid", "json", "jsonb", "unique", "primary", "foreign", "constraint", "references", "index",
            "default", "cascade", "null", "column", "table",
        )
        private val PROSE_IDENTIFIER_RE = Regex("""`([^`\s]+)`|"([\w.]+)"|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b""", RegexOption.IGNORE_CASE)

        /**
         * Identifier-shaped names in a prose answer absent from the catalog - the grounding floor
         * for [explainSchema]. Conservative: only snake_case and quoted/backticked tokens are checked,
         * so ordinary English never trips it while an invented `customer_history` is caught.
         */
        internal fun unknownReferencesInProse(answer: String, catalog: SchemaCatalog): List<String> {
            val known = HashSet<String>()
            for (s in catalog.schemas) known += s.lowercase()
            for (t in catalog.tables) {
                known += t.name.lowercase()
                if (t.schema != null) {
                    known += t.schema.lowercase()
                    known += "${t.schema.lowercase()}.${t.name.lowercase()}"
                }
                for (c in t.columns) known += c.name.lowercase()
            }
            val found = LinkedHashSet<String>()
            for (m in PROSE_IDENTIFIER_RE.findAll(answer)) {
                val raw = (m.groupValues[1].ifEmpty { m.groupValues[2] }.ifEmpty { m.groupValues[3] }).lowercase()
                if (raw.isEmpty() || raw in NON_IDENTIFIER_SNAKE) continue
                val bare = if (raw.contains('.')) raw.substringAfterLast('.') else raw
                if (raw in known || bare in known) continue
                found += raw
            }
            return found.toList()
        }

        /** Each engine's read-only way to list tables; system schemas are exempt from the hallucination floor. */
        internal fun catalogQueryHint(engine: com.rahulmahadik.asksql.ide.model.EngineKind): String = when (engine) {
            com.rahulmahadik.asksql.ide.model.EngineKind.SQLITE ->
                "SELECT name, type FROM sqlite_master WHERE type IN ('table','view')"
            com.rahulmahadik.asksql.ide.model.EngineKind.MYSQL ->
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE()"
            com.rahulmahadik.asksql.ide.model.EngineKind.ORACLE ->
                "SELECT table_name FROM all_tables"
            else ->
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"
        }
    }

    data class AskResult(
        val sql: String,
        val explanation: String?,
        val guard: GuardVerdict,
        val connectionId: String,
        val repairs: Int,
    )

    private data class CachedCatalog(val catalog: SchemaCatalog, val fetchedAtMillis: Long)

    private val catalogCache = ConcurrentHashMap<String, CachedCatalog>()
    private val catalogLocks = ConcurrentHashMap<String, Mutex>()
    private val catalogGeneration = java.util.concurrent.atomic.AtomicLong(0)

    /** Drops every cached catalog entry. Call on any connection-settings change; the 300s TTL alone would keep serving the old schema. */
    fun invalidateCatalogCache() {
        catalogGeneration.incrementAndGet()
        catalogCache.clear()
    }

    // -----------------------------------------------------------------
    // Catalog (300s TTL, single in-flight fetch per connection)
    // -----------------------------------------------------------------

    suspend fun catalog(descriptor: ConnectionDescriptor, password: String?, refresh: Boolean = false): SchemaCatalog {
        val cached = catalogCache[descriptor.id]
        if (!refresh && cached != null && System.currentTimeMillis() - cached.fetchedAtMillis < CATALOG_TTL.inWholeMilliseconds) {
            return cached.catalog
        }
        val lock = catalogLocks.getOrPut(descriptor.id) { Mutex() }
        return lock.withLock {
            val recheck = catalogCache[descriptor.id]
            if (!refresh && recheck != null && System.currentTimeMillis() - recheck.fetchedAtMillis < CATALOG_TTL.inWholeMilliseconds) {
                return@withLock recheck.catalog
            }
            val gen = catalogGeneration.get()
            // Blocking JDBC: without a hard bound, a hung network mount would leave "Reading schema" stuck forever.
            val fresh = withHardTimeout(60_000) {
                connectionRegistry.withConnection(descriptor, password) { connection ->
                    Introspectors.forEngine(descriptor.engine).introspect(connection)
                }
            }
            // Skip the write if an edit invalidated mid-fetch, or this stores the old target's schema.
            if (catalogGeneration.get() == gen) catalogCache[descriptor.id] = CachedCatalog(fresh, System.currentTimeMillis())
            fresh
        }
    }

    // -----------------------------------------------------------------
    // ask(): question -> catalog -> prune -> prompt -> LLM -> extract ->
    //        guard -> hallucination floors -> repair loop
    // -----------------------------------------------------------------

    suspend fun ask(
        question: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        llmClient: LlmClient,
        context: List<Prompts.ContextTurn> = emptyList(),
        onEvent: EngineEventListener? = null,
        /** From `AskSqlAppSettings.customInstructions`; see [Prompts.buildSqlSystem]. */
        customInstructions: String? = null,
    ): AskResult {
        val q = question.trim()
        if (q.isEmpty()) throw AskSqlException(AskSqlErrorCode.INVALID_INPUT)
        if (q.length > 10_000) {
            throw AskSqlException(
                AskSqlErrorCode.INVALID_INPUT,
                userMessage = "The question is too long. Keep it under 10,000 characters.",
            )
        }

        val dialect = Dialects.of(descriptor.engine)

        onEvent?.onEvent(EngineEvent.StageEvent(Stage.CATALOG))
        val fullCatalog = catalog(descriptor, password)

        onEvent?.onEvent(EngineEvent.StageEvent(Stage.PRUNE))
        val initialPrunerSettings = CatalogPruner.PrunerSettings(maxSchemaTokens = maxSchemaTokens)
        var pruned = CatalogPruner.pruneCatalog(fullCatalog, q, initialPrunerSettings)
        var schemaText = pruned.schemaText
        if (pruned.dropped > 0) {
            onEvent?.onEvent(EngineEvent.Warning("Schema narrowed to ${pruned.catalog.tables.size} relevant tables."))
        }

        val system = Prompts.buildSqlSystem(dialect, policy.maxRows, customInstructions)
        var userPrompt = Prompts.buildSqlUser(question = q, schemaText = schemaText, context = context)

        var lastSql = ""
        var attempt = 0
        var contextShrunk = false
        var triedFuzzyTableRepair = false
        var triedCatalogRepair = false
        while (true) {
            onEvent?.onEvent(EngineEvent.StageEvent(if (attempt == 0) Stage.LLM else Stage.REPAIR, "attempt ${attempt + 1}"))

            val result = try {
                com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
                    llmClient.chat(system, userPrompt) { token -> onEvent?.onEvent(EngineEvent.Token(token)) }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e // must propagate unwrapped: this IS the coroutine's own cancellation signal, not an LLM failure
            } catch (e: AskSqlException) {
                // On context overflow, shrink the schema once and retry without consuming a repair
                // attempt; a too-long prompt for a small-context model is not a provider outage.
                if (e.code == AskSqlErrorCode.LLM_CONTEXT_OVERFLOW && !contextShrunk) {
                    contextShrunk = true
                    val tighter = CatalogPruner.pruneCatalog(
                        fullCatalog, q,
                        CatalogPruner.PrunerSettings(
                            maxTables = maxOf(5, pruned.catalog.tables.size / 2),
                            maxSchemaTokens = maxOf(1000, initialPrunerSettings.maxSchemaTokens / 2),
                        ),
                    )
                    pruned = tighter
                    schemaText = tighter.schemaText
                    userPrompt = Prompts.buildSqlUser(question = q, schemaText = schemaText, context = context)
                    continue
                }
                throw e
            } catch (e: Exception) {
                throw AskSqlException.from(e, AskSqlErrorCode.LLM_UNAVAILABLE)
            }
            val text = result.text

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.EXTRACT))
            // extractSql runs first: a model can hedge with "IMPOSSIBLE: ..." and still produce a
            // usable SQL fence right after; prefer the SQL if there is any.
            val extraction = Extract.extractSql(text)
            if (extraction == null) {
                val impossibleReason = Extract.extractImpossible(text)
                if (impossibleReason != null) {
                    // "show tables" is not a SELECT, so the model refuses; the same answer is a plain
                    // SELECT over the catalog views, which the guard and hallucination floor both allow.
                    if (!triedCatalogRepair && isMetadataQuestion(q) && attempt < MAX_REPAIRS) {
                        triedCatalogRepair = true
                        userPrompt = Prompts.buildRepairUser(
                            question = q, failedSql = "",
                            failure = "This asks about the database's own structure. Don't use SHOW/DESCRIBE, and don't invent a schema name to filter on. Answer with exactly this query, unchanged: ${catalogQueryHint(descriptor.engine)}",
                            schemaText = schemaText, dialect = dialect,
                        )
                        attempt++
                        continue
                    }
                    // A refusal is often a misspelled table name ("appointmnts" vs "appointments"); one
                    // repair attempt, told to disclose the correction, beats a flat refusal.
                    val fuzzyTable = if (!triedFuzzyTableRepair) SchemaFuzzyMatch.closestTableName(q, fullCatalog) else null
                    if (fuzzyTable != null && attempt < MAX_REPAIRS) {
                        triedFuzzyTableRepair = true
                        userPrompt = Prompts.buildRepairUser(
                            question = q, failedSql = "",
                            failure = "No table matches the question exactly, but \"$fuzzyTable\" is a close match, likely the same word misspelled. If that's what's meant, answer using \"$fuzzyTable\" and say in the explanation that an exact match wasn't found so \"$fuzzyTable\" was used instead.",
                            schemaText = schemaText, dialect = dialect,
                        )
                        attempt++
                        continue
                    }
                    throw AskSqlException(AskSqlErrorCode.LLM_CANNOT_ANSWER, userMessage = impossibleReason, retryable = false)
                }
            }
            if (extraction == null) {
                if (attempt >= MAX_REPAIRS) {
                    val refusal = Extract.looksLikeRefusal(text)
                    throw AskSqlException(
                        if (refusal) AskSqlErrorCode.LLM_REFUSAL else AskSqlErrorCode.LLM_BAD_OUTPUT,
                        detail = "no SQL extracted after ${attempt + 1} attempts",
                    )
                }
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = lastSql,
                    failure = "The response contained no SQL statement. Reply with one SELECT in a ```sql fence.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }
            lastSql = extraction.sql

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.GUARD))
            val verdict = SqlGuard.guard(extraction.sql, dialect, policy)
            if (!verdict.allowed) {
                if (attempt >= MAX_REPAIRS) {
                    history.add(auditEntry(descriptor.id, q, extraction.sql, HistoryStatus.BLOCKED, verdict.ruleId))
                    throw AskSqlException(
                        AskSqlErrorCode.GUARD_BLOCKED,
                        userMessage = "I didn't run that one for safety: ${verdict.reason ?: "the generated statement is not allowed."}",
                        detail = "ruleId=${verdict.ruleId} after ${attempt + 1} attempts",
                    )
                }
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = extraction.sql,
                    failure = "The SQL validator rejected it: ${verdict.reason ?: verdict.ruleId ?: "not allowed"}. Produce a single read-only SELECT.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }

            // A model dodging a question by SELECTing a hardcoded string is not a real query. Narrowed
            // to literal string constants only: SELECT version()/NOW() are genuine zero-table answers.
            if (verdict.tables.isEmpty() && (verdict.sql.contains("IMPOSSIBLE", ignoreCase = true) || LITERAL_STRING_ANSWER_RE.containsMatchIn(verdict.sql.trim()))) {
                throw AskSqlException(
                    AskSqlErrorCode.LLM_CANNOT_ANSWER,
                    userMessage = "That question doesn't seem to match any table in this database.",
                    retryable = false,
                )
            }

            val unknownTable = HallucinationChecks.firstUnknownTable(verdict.sql, fullCatalog, verdict.tables)
            if (unknownTable != null) {
                if (attempt >= MAX_REPAIRS) {
                    throw AskSqlException(
                        AskSqlErrorCode.LLM_BAD_OUTPUT,
                        userMessage = "I couldn't find a table called \"$unknownTable\" in this database. Try rephrasing, or check the schema tree above.",
                        retryable = false,
                    )
                }
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = verdict.sql,
                    failure = "Table \"$unknownTable\" does not exist in the schema. Use only tables from the <schema> block.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }

            val unknownColumn = HallucinationChecks.firstUnknownColumn(verdict.sql, fullCatalog)
            if (unknownColumn != null) {
                if (attempt >= MAX_REPAIRS) {
                    throw AskSqlException(
                        AskSqlErrorCode.LLM_BAD_OUTPUT,
                        userMessage = "There's no \"${unknownColumn.column}\" column on ${unknownColumn.table} in this database. Try rephrasing, or check the schema tree above.",
                        retryable = false,
                    )
                }
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = verdict.sql,
                    failure = "Column \"${unknownColumn.column}\" does not exist on table \"${unknownColumn.table}\". Its real columns are: ${unknownColumn.available.joinToString(", ")}.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.DONE))
            return AskResult(
                sql = verdict.sql,
                explanation = extraction.explanation,
                guard = verdict,
                connectionId = descriptor.id,
                repairs = attempt,
            )
        }
    }

    // -----------------------------------------------------------------
    // execute(): guard EVERY sql, even one the caller already saw guarded once; an
    // edited-then-replayed statement is re-verified from scratch.
    // -----------------------------------------------------------------

    suspend fun execute(
        sql: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        question: String? = null,
        maxRows: Int? = null,
        timeoutMs: Long = DEFAULT_QUERY_TIMEOUT_MS,
    ): AskSqlResultSet {
        val dialect = Dialects.of(descriptor.engine)
        val verdict = SqlGuard.guard(sql, dialect, policy)
        if (!verdict.allowed) {
            history.add(auditEntry(descriptor.id, question, sql, HistoryStatus.BLOCKED, verdict.ruleId))
            throw AskSqlException(
                AskSqlErrorCode.GUARD_BLOCKED,
                userMessage = "I didn't run that one for safety: ${verdict.reason ?: "this statement is not allowed."}",
                detail = "ruleId=${verdict.ruleId} sql=${sql.take(300)}",
            )
        }

        val started = System.currentTimeMillis()
        // Clamp the caller's maxRows to the policy ceiling; for fetch-style dialects (Oracle) no LIMIT
        // is injected, so this driver cap is the only bound against materializing a whole table.
        val cappedMax = minOf(maxRows ?: policy.maxRows, policy.maxRows)
        return try {
            val result = connectionRegistry.withConnection(descriptor, password) { connection ->
                JdbcExecutor.execute(connection, verdict.sql, cappedMax, timeoutMs, descriptor.engine)
            }
            history.add(auditEntry(descriptor.id, question, verdict.sql, HistoryStatus.OK, durationMs = System.currentTimeMillis() - started, rowCount = result.rowCount))
            val warnings = result.warnings.toMutableList()
            if (verdict.autoLimited) warnings += "A row limit of ${policy.maxRows} was added automatically - export to get everything."
            if (verdict.loweredLimit) warnings += "The row limit was lowered to ${policy.maxRows}."
            // The injected LIMIT equals maxRows, so the executor cannot see the overflow row; when we
            // auto-limited and the result filled the cap, surface truncation for the "export" banner.
            val truncated = result.truncated || (verdict.autoLimited && result.rowCount >= cappedMax)
            result.copy(warnings = warnings, truncated = truncated)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // a user-initiated cancel, not a query failure; must propagate unwrapped and unaudited
        } catch (e: Exception) {
            val mapped = AskSqlException.from(e, AskSqlErrorCode.DB_QUERY_ERROR)
            history.add(auditEntry(descriptor.id, question, verdict.sql, HistoryStatus.ERROR, mapped.code.name, System.currentTimeMillis() - started))
            throw mapped
        }
    }

    /**
     * Asks the model to correct a database-rejected statement, grounded in the schema. Returns the
     * guarded corrected SQL, or null without a safe, different suggestion. Never runs the query.
     */
    suspend fun suggestFix(
        failedSql: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        question: String?,
        errorDetail: String?,
        llmClient: LlmClient,
        customInstructions: String? = null,
    ): String? {
        val bad = failedSql.trim()
        val q = question?.trim().orEmpty()
        if (bad.isEmpty() || q.isEmpty()) return null
        return try {
            val dialect = Dialects.of(descriptor.engine)
            val catalog = catalog(descriptor, password)
            val schemaText = CatalogPruner.pruneCatalog(catalog, q).schemaText
            val repairPrompt = Prompts.buildRepairUser(
                question = q, failedSql = bad,
                failure = "The database rejected it: ${errorDetail ?: "the query failed to run"}",
                schemaText = schemaText, dialect = dialect,
            )
            val repaired = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
                llmClient.chat(Prompts.buildSqlSystem(dialect, policy.maxRows, customInstructions), repairPrompt)
            }
            val extraction = Extract.extractSql(repaired.text) ?: return null
            val verdict = SqlGuard.guard(extraction.sql, dialect, policy)
            if (!verdict.allowed || verdict.sql == bad) return null
            // ask()'s repair loop enforces these same floors: a "fix" referencing a table/column
            // that doesn't exist would just fail again once re-approved.
            if (HallucinationChecks.firstUnknownTable(verdict.sql, catalog, verdict.tables) != null) return null
            if (HallucinationChecks.firstUnknownColumn(verdict.sql, catalog) != null) return null
            verdict.sql
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // a user-initiated cancel is not "no fix available"; must propagate
        } catch (e: Exception) {
            null // best-effort; the original error stands
        }
    }

    suspend fun explain(sql: String, descriptor: ConnectionDescriptor, password: String?, llmClient: LlmClient): String {
        val s = sql.trim()
        if (s.isEmpty()) throw AskSqlException(AskSqlErrorCode.INVALID_INPUT, userMessage = "Provide a SQL statement to explain.")
        val dialect = Dialects.of(descriptor.engine)
        // Guard first: `sql` is caller-supplied, so without this, explain() is a free text channel
        // to the model on the host's API key. Every caller today only passes already-guarded SQL,
        // so this is defense-in-depth against a future "explain arbitrary selection" action.
        val verdict = SqlGuard.guard(s, dialect, policy)
        if (!verdict.allowed) {
            throw AskSqlException(
                AskSqlErrorCode.GUARD_BLOCKED,
                userMessage = "Only a read-only SQL query can be explained.",
                detail = "explain blocked: ${verdict.reason ?: "not a read-only statement"}",
            )
        }
        val schemaText = try {
            CatalogPruner.pruneCatalog(catalog(descriptor, password), s).schemaText
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        val result = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
            llmClient.chat(Prompts.buildExplainSystem(dialect), Prompts.buildExplainUser(s, schemaText))
        }
        return result.text.trim()
    }

    data class SchemaAnswer(
        val answer: String,
        val tables: List<String>,
        val grounded: Boolean,
        val unknownReferences: List<String>,
        val isSchemaChange: Boolean,
    )

    /**
     * Answer a natural-language question about the schema in prose, grounded in the catalog.
     * Structure only - never data values, since no query runs. [SchemaAnswer.grounded] is false
     * if the answer named identifiers absent from the schema.
     */
    suspend fun explainSchema(
        question: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        llmClient: LlmClient,
    ): SchemaAnswer {
        val q = question.trim()
        if (q.isEmpty()) throw AskSqlException(AskSqlErrorCode.INVALID_INPUT, userMessage = "Ask a question about the schema.")
        val dialect = Dialects.of(descriptor.engine)
        val fullCatalog = catalog(descriptor, password)
        if (fullCatalog.tables.isEmpty()) {
            return SchemaAnswer("This connection has no tables the current user can read.", emptyList(), true, emptyList(), false)
        }
        val isSchemaChange = SCHEMA_CHANGE_RE.containsMatchIn(q)
        // A whole-schema question ("how are the tables related?", "summarize this database") needs the full
        // picture. Term-based pruning would narrow it to a couple of tables, so instead pass a compact list of
        // ALL tables plus the full join graph (declared + naming-inferred).
        val schemaText: String
        val relationships: List<String>
        val contextTables: List<TableInfo>
        if (BROAD_SCHEMA_RE.containsMatchIn(q)) {
            relationships = CatalogPruner.joinGraph(fullCatalog)
            val list = fullCatalog.tables.joinToString("\n") { t ->
                val pk = if (t.primaryKey.isNotEmpty()) ", pk ${t.primaryKey.joinToString(",")}" else ""
                "${if (t.schema != null) "${t.schema}." else ""}${t.name} (${t.kind.name.lowercase()}, ${t.columns.size} cols$pk)"
            }
            schemaText = "This database has exactly ${fullCatalog.tables.size} tables/views. Full list:\n$list"
            contextTables = fullCatalog.tables
        } else {
            val pruned = CatalogPruner.pruneCatalog(fullCatalog, q)
            schemaText = pruned.schemaText
            relationships = CatalogPruner.joinGraph(pruned.catalog)
            contextTables = pruned.catalog.tables
        }
        val tables = contextTables.map { if (it.schema != null) "${it.schema}.${it.name}" else it.name }
        val system = Prompts.buildSchemaAnswerSystem(dialect, isSchemaChange)
        var answer = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
            llmClient.chat(system, Prompts.buildSchemaAnswerUser(q, schemaText, relationships))
        }.text.trim()
        // Grounding floor checked against the full catalog, so a real table dropped by pruning isn't flagged.
        var unknown = unknownReferencesInProse(answer, fullCatalog)
        // One repair pass for understanding questions: a name absent from the schema is a hallucination,
        // so regenerate constrained to real names. Skipped for a change request, where new names are the proposal.
        if (unknown.isNotEmpty() && !isSchemaChange) {
            answer = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
                llmClient.chat(system, Prompts.buildSchemaAnswerRepairUser(q, schemaText, unknown, relationships))
            }.text.trim()
            unknown = unknownReferencesInProse(answer, fullCatalog)
        }
        return SchemaAnswer(answer, tables, unknown.isEmpty(), unknown, isSchemaChange)
    }

    private fun auditEntry(
        connectionId: String,
        question: String?,
        sql: String,
        status: HistoryStatus,
        errorCode: String? = null,
        durationMs: Long? = null,
        rowCount: Int? = null,
    ) = HistoryEntry(
        id = newHistoryId(),
        at = java.time.Instant.now(),
        connectionId = connectionId,
        question = question,
        sql = sql,
        status = status,
        errorCode = errorCode,
        durationMs = durationMs,
        rowCount = rowCount,
    )
}
