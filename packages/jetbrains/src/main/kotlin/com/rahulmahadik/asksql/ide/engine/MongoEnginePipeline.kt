package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.MongoClientRegistry
import com.rahulmahadik.asksql.ide.db.MongoQueryExecutor
import com.rahulmahadik.asksql.ide.db.introspect.MongoIntrospector
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.guard.MongoGuard
import com.rahulmahadik.asksql.ide.llm.LlmClient
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.EngineEvent
import com.rahulmahadik.asksql.ide.model.EngineEventListener
import com.rahulmahadik.asksql.ide.model.MongoGuardPolicy
import com.rahulmahadik.asksql.ide.model.MongoGuardVerdict
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.Stage
import com.rahulmahadik.asksql.ide.util.withHardTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Duration.Companion.seconds

/**
 * MongoDB's counterpart to [EnginePipeline]: same repair-loop shape and event stages. Not a
 * parameterization of it, since MongoDB has no SQL/JDBC/Dialect concept to share.
 */
class MongoEnginePipeline(
    private val clientRegistry: MongoClientRegistry,
    private val history: HistoryStore = InMemoryHistoryStore(),
    /** A `var`, not a `val`: see [EnginePipeline.policy]'s doc for why. */
    var policy: MongoGuardPolicy = MongoGuardPolicy(),
    /** Schema token budget, refreshed from settings on every access like [policy]. */
    var maxSchemaTokens: Int = CatalogPruner.PrunerSettings().maxSchemaTokens,
) {
    companion object {
        private const val MAX_REPAIRS = 2
        private val CATALOG_TTL = 300.seconds
        private const val DEFAULT_QUERY_TIMEOUT_MS = 30_000L
    }

    data class MongoAskResult(
        val pipelineJson: String,
        val collection: String,
        val explanation: String?,
        val guard: MongoGuardVerdict,
        val connectionId: String,
        val repairs: Int,
    )

    /** [MongoEnginePipeline.suggestFix]'s return shape: unlike SQL, the target collection lives outside the pipeline JSON, so the caller needs it returned separately. */
    data class MongoFix(val collection: String, val pipelineJson: String)

    private data class CachedCatalog(val catalog: SchemaCatalog, val fetchedAtMillis: Long)

    private val catalogCache = ConcurrentHashMap<String, CachedCatalog>()
    private val catalogLocks = ConcurrentHashMap<String, Mutex>()
    private val catalogGeneration = java.util.concurrent.atomic.AtomicLong(0)

    /** Same reasoning as [EnginePipeline.invalidateCatalogCache]. */
    fun invalidateCatalogCache() {
        catalogGeneration.incrementAndGet()
        catalogCache.clear()
    }

    private fun requireDatabase(descriptor: ConnectionDescriptor): String =
        descriptor.database?.takeIf { it.isNotBlank() } ?: throw AskSqlException(
            AskSqlErrorCode.CONFIG_ERROR,
            userMessage = "This MongoDB connection has no database name configured.",
        )

    // -----------------------------------------------------------------
    // Catalog (300s TTL, single in-flight fetch per connection): same pattern as
    // EnginePipeline.catalog(), but sampling-based instead of metadata-based.
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
            val dbName = requireDatabase(descriptor)
            val gen = catalogGeneration.get()
            // Hard Future.get(timeout) bound: a stuck sampling introspection must not hang "Reading schema" forever.
            val fresh = withHardTimeout(60_000) {
                clientRegistry.withClient(descriptor, password) { client ->
                    MongoIntrospector.introspect(client.getDatabase(dbName))
                }
            }
            // Skip the write if an edit invalidated mid-fetch, or this stores the old target's schema.
            if (catalogGeneration.get() == gen) catalogCache[descriptor.id] = CachedCatalog(fresh, System.currentTimeMillis())
            fresh
        }
    }

    // -----------------------------------------------------------------
    // ask(): question -> catalog -> prune -> prompt -> LLM -> extract ->
    //        guard -> collection-exists floor -> repair loop
    // -----------------------------------------------------------------

    suspend fun ask(
        question: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        llmClient: LlmClient,
        context: List<MongoPrompts.ContextTurn> = emptyList(),
        onEvent: EngineEventListener? = null,
        customInstructions: String? = null,
    ): MongoAskResult {
        val q = question.trim()
        if (q.isEmpty()) throw AskSqlException(AskSqlErrorCode.INVALID_INPUT)
        if (q.length > 10_000) {
            throw AskSqlException(
                AskSqlErrorCode.INVALID_INPUT,
                userMessage = "The question is too long. Keep it under 10,000 characters.",
            )
        }

        onEvent?.onEvent(EngineEvent.StageEvent(Stage.CATALOG))
        val fullCatalog = catalog(descriptor, password)

        onEvent?.onEvent(EngineEvent.StageEvent(Stage.PRUNE))
        val initialPrunerSettings = CatalogPruner.PrunerSettings(maxSchemaTokens = maxSchemaTokens)
        var pruned = CatalogPruner.pruneCatalog(fullCatalog, q, initialPrunerSettings)
        var schemaText = pruned.schemaText
        if (pruned.dropped > 0) {
            onEvent?.onEvent(EngineEvent.Warning("Schema narrowed to ${pruned.catalog.tables.size} relevant collections."))
        }

        val system = MongoPrompts.buildPipelineSystem(policy.maxRows, customInstructions)
        var userPrompt = MongoPrompts.buildPipelineUser(question = q, schemaText = schemaText, context = context)

        var lastPipeline = ""
        var attempt = 0
        var contextShrunk = false
        var triedFuzzyCollectionRepair = false
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
                // attempt (see EnginePipeline.ask's identical handling).
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
                    userPrompt = MongoPrompts.buildPipelineUser(question = q, schemaText = schemaText, context = context)
                    continue
                }
                throw e
            } catch (e: Exception) {
                throw AskSqlException.from(e, AskSqlErrorCode.LLM_UNAVAILABLE)
            }
            val text = result.text

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.EXTRACT))
            val extraction = MongoExtract.extractPipeline(text)
            if (extraction == null) {
                val impossibleReason = Extract.extractImpossible(text)
                if (impossibleReason != null) {
                    // Same idea as EnginePipeline.ask: a refusal is often a misspelled collection
                    // name, not a genuinely missing one - one repair attempt, told to disclose it.
                    val fuzzyCollection = if (!triedFuzzyCollectionRepair) SchemaFuzzyMatch.closestTableName(q, fullCatalog) else null
                    if (fuzzyCollection != null && attempt < MAX_REPAIRS) {
                        triedFuzzyCollectionRepair = true
                        userPrompt = MongoPrompts.buildRepairUser(
                            question = q, failedPipeline = "",
                            failure = "No collection matches the question exactly, but \"$fuzzyCollection\" is a close match, likely the same word misspelled. If that's what's meant, answer using \"$fuzzyCollection\" and say in the explanation that an exact match wasn't found so \"$fuzzyCollection\" was used instead.",
                            schemaText = schemaText,
                        )
                        attempt++
                        continue
                    }
                    throw AskSqlException(AskSqlErrorCode.LLM_CANNOT_ANSWER, userMessage = impossibleReason, retryable = false)
                }
                if (attempt >= MAX_REPAIRS) {
                    val refusal = Extract.looksLikeRefusal(text)
                    throw AskSqlException(
                        if (refusal) AskSqlErrorCode.LLM_REFUSAL else AskSqlErrorCode.LLM_BAD_OUTPUT,
                        detail = "no pipeline extracted after ${attempt + 1} attempts",
                    )
                }
                userPrompt = MongoPrompts.buildRepairUser(
                    question = q, failedPipeline = lastPipeline,
                    failure = "The response contained no db.<collection>.aggregate([...]) call. Reply with one in a ```js fence.",
                    schemaText = schemaText,
                )
                attempt++
                continue
            }
            lastPipeline = extraction.pipelineJson

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.GUARD))
            val verdict = MongoGuard.guard(extraction.pipelineJson, policy)
            if (!verdict.allowed) {
                if (attempt >= MAX_REPAIRS) {
                    history.add(auditEntry(descriptor.id, q, extraction.pipelineJson, HistoryStatus.BLOCKED, verdict.ruleId))
                    throw AskSqlException(
                        AskSqlErrorCode.GUARD_BLOCKED,
                        userMessage = "I didn't run that one for safety: ${verdict.reason ?: "the generated pipeline is not allowed."}",
                        detail = "ruleId=${verdict.ruleId} after ${attempt + 1} attempts",
                    )
                }
                userPrompt = MongoPrompts.buildRepairUser(
                    question = q, failedPipeline = extraction.pipelineJson,
                    failure = "The pipeline validator rejected it: ${verdict.reason ?: verdict.ruleId ?: "not allowed"}. Produce a single read-only pipeline.",
                    schemaText = schemaText,
                )
                attempt++
                continue
            }

            // Collections are enumerable exactly, so an unknown one is a hard block. MongoDB
            // collection names are case-sensitive, so resolve to the catalog's real casing:
            // querying "Orders" when only "orders" exists would silently return zero documents.
            val resolvedCollection = fullCatalog.tables.firstOrNull { it.name.equals(extraction.collection, ignoreCase = true) }?.name
            if (resolvedCollection == null) {
                if (attempt >= MAX_REPAIRS) {
                    throw AskSqlException(
                        AskSqlErrorCode.LLM_BAD_OUTPUT,
                        userMessage = "I couldn't find a collection called \"${extraction.collection}\" in this database. Try rephrasing, or check the schema tree above.",
                        retryable = false,
                    )
                }
                userPrompt = MongoPrompts.buildRepairUser(
                    question = q, failedPipeline = verdict.pipelineJson,
                    failure = "Collection \"${extraction.collection}\" does not exist in the schema. Use only collections from the <schema> block.",
                    schemaText = schemaText,
                )
                attempt++
                continue
            }

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.DONE))
            return MongoAskResult(
                pipelineJson = verdict.pipelineJson,
                collection = resolvedCollection,
                explanation = extraction.explanation,
                guard = verdict,
                connectionId = descriptor.id,
                repairs = attempt,
            )
        }
    }

    // -----------------------------------------------------------------
    // execute(): guard EVERY pipeline, even one the caller already saw guarded once;
    // an edited-then-replayed pipeline is re-verified from scratch.
    // -----------------------------------------------------------------

    suspend fun execute(
        pipelineJson: String,
        collection: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        question: String? = null,
        maxRows: Int? = null,
        timeoutMs: Long = DEFAULT_QUERY_TIMEOUT_MS,
    ): AskSqlResultSet {
        val verdict = MongoGuard.guard(pipelineJson, policy)
        if (!verdict.allowed) {
            history.add(auditEntry(descriptor.id, question, pipelineJson, HistoryStatus.BLOCKED, verdict.ruleId))
            throw AskSqlException(
                AskSqlErrorCode.GUARD_BLOCKED,
                userMessage = "I didn't run that one for safety: ${verdict.reason ?: "this pipeline is not allowed."}",
                detail = "ruleId=${verdict.ruleId} pipeline=${pipelineJson.take(300)}",
            )
        }

        // Re-checked here too (same floor as ask()): Mongo silently returns zero rows for a
        // nonexistent collection, so a stale/wrong-case name would look like "no matching rows".
        val fullCatalog = catalog(descriptor, password)
        val resolvedCollection = fullCatalog.tables.firstOrNull { it.name.equals(collection, ignoreCase = true) }?.name
            ?: throw AskSqlException(
                AskSqlErrorCode.DB_QUERY_ERROR,
                userMessage = "The collection \"$collection\" doesn't exist.",
                detail = "execute() target collection not found in catalog",
            )

        val dbName = requireDatabase(descriptor)
        val started = System.currentTimeMillis()
        return try {
            val result = clientRegistry.withClient(descriptor, password) { client ->
                val stages = MongoGuard.parsePipeline(verdict.pipelineJson)
                MongoQueryExecutor.execute(client.getDatabase(dbName), resolvedCollection, stages, maxRows ?: policy.maxRows, timeoutMs)
            }
            history.add(auditEntry(descriptor.id, question, verdict.pipelineJson, HistoryStatus.OK, durationMs = System.currentTimeMillis() - started, rowCount = result.rowCount))
            val warnings = result.warnings.toMutableList()
            if (verdict.autoLimited) warnings += "A row limit of ${policy.maxRows} was added automatically - export to get everything."
            if (verdict.loweredLimit) warnings += "The row limit was lowered to ${policy.maxRows}."
            result.copy(warnings = warnings)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // a user-initiated cancel, not a query failure; must propagate unwrapped and unaudited
        } catch (e: Exception) {
            val mapped = AskSqlException.from(e, AskSqlErrorCode.DB_QUERY_ERROR)
            history.add(auditEntry(descriptor.id, question, verdict.pipelineJson, HistoryStatus.ERROR, mapped.code.name, System.currentTimeMillis() - started))
            throw mapped
        }
    }

    /**
     * Asks the model to correct a database-rejected pipeline, grounded in the schema. Returns the
     * guarded [MongoFix], or null without a safe, different suggestion. Never runs the query.
     */
    suspend fun suggestFix(
        failedPipeline: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        question: String?,
        errorDetail: String?,
        llmClient: LlmClient,
        customInstructions: String? = null,
    ): MongoFix? {
        val bad = failedPipeline.trim()
        val q = question?.trim().orEmpty()
        if (bad.isEmpty() || q.isEmpty()) return null
        return try {
            val catalog = catalog(descriptor, password)
            val schemaText = CatalogPruner.pruneCatalog(catalog, q).schemaText
            val repairPrompt = MongoPrompts.buildRepairUser(
                question = q, failedPipeline = bad,
                failure = "The database rejected it: ${errorDetail ?: "the query failed to run"}",
                schemaText = schemaText,
            )
            val repaired = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
                llmClient.chat(MongoPrompts.buildPipelineSystem(policy.maxRows, customInstructions), repairPrompt)
            }
            val extraction = MongoExtract.extractPipeline(repaired.text) ?: return null
            val verdict = MongoGuard.guard(extraction.pipelineJson, policy)
            if (!verdict.allowed || verdict.pipelineJson == bad) return null
            // Same collection-existence floor and case resolution as ask(): a "fix" naming a
            // nonexistent or differently-cased collection would just fail again once re-approved.
            val resolvedCollection = catalog.tables.firstOrNull { it.name.equals(extraction.collection, ignoreCase = true) }?.name ?: return null
            MongoFix(resolvedCollection, verdict.pipelineJson)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // a user-initiated cancel is not "no fix available"; must propagate
        } catch (e: Exception) {
            null // best-effort; the original error stands
        }
    }

    suspend fun explain(pipelineJson: String, descriptor: ConnectionDescriptor, password: String?, llmClient: LlmClient): String {
        val p = pipelineJson.trim()
        if (p.isEmpty()) throw AskSqlException(AskSqlErrorCode.INVALID_INPUT, userMessage = "Provide a pipeline to explain.")
        // Guard first: without it, explain() is a free text channel to the model on the host's
        // API key (see EnginePipeline.explain's identical check).
        val verdict = MongoGuard.guard(p, policy)
        if (!verdict.allowed) {
            throw AskSqlException(
                AskSqlErrorCode.GUARD_BLOCKED,
                userMessage = "Only a read-only aggregation pipeline can be explained.",
                detail = "explain blocked: ${verdict.reason ?: "not an allowed pipeline"}",
            )
        }
        val schemaText = try {
            CatalogPruner.pruneCatalog(catalog(descriptor, password), p).schemaText
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        val result = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
            llmClient.chat(MongoPrompts.buildExplainSystem(), MongoPrompts.buildExplainUser(p, schemaText))
        }
        return result.text.trim()
    }

    private fun auditEntry(
        connectionId: String,
        question: String?,
        pipelineJson: String,
        status: HistoryStatus,
        errorCode: String? = null,
        durationMs: Long? = null,
        rowCount: Int? = null,
    ) = HistoryEntry(
        id = newHistoryId(),
        at = java.time.Instant.now(),
        connectionId = connectionId,
        question = question,
        sql = pipelineJson,
        status = status,
        errorCode = errorCode,
        durationMs = durationMs,
        rowCount = rowCount,
    )
}
