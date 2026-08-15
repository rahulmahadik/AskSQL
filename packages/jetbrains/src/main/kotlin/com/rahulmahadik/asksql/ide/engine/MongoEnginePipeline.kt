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
 * MongoDB's counterpart to [EnginePipeline]: same repair-loop shape and event stages, sharing no
 * SQL/JDBC/Dialect concept with it.
 */
class MongoEnginePipeline(
    private val clientRegistry: MongoClientRegistry,
    private val history: HistoryStore = InMemoryHistoryStore(),
    /** A `var`, not a `val`: see [EnginePipeline.policy]'s doc for why. */
    var policy: MongoGuardPolicy = MongoGuardPolicy(),
    /** Schema token budget, refreshed from settings on every access like [policy]. */
    var maxSchemaTokens: Int = CatalogPruner.PrunerSettings().maxSchemaTokens,
    /** Send example field values to the model. Off by default: only the schema leaves the machine. */
    var allowDataInPrompt: Boolean = false,
) {
    companion object {
        private const val MAX_REPAIRS = 2
        private val CATALOG_TTL = 300.seconds
        private const val DEFAULT_QUERY_TIMEOUT_MS = 30_000L

        /** A question asking to add/change/remove data or collections, where new names are proposals; word-for-word the SQL path's list. */
        private val MONGO_SCHEMA_CHANGE_RE = Grounding.SCHEMA_CHANGE_RE

        /** The model saying in prose that it cannot answer while still emitting a pipeline. */
        private val CANNOT_ANSWER_RE = Regex(
            """\b(?:impossible to answer|impossible to determine|cannot be answered|can(?:no|')t be answered|not possible to answer|unable to answer|no way to answer|(?:does not|doesn't|do not|don't) (?:contain|have) (?:any |the )?(?:information|data|fields?|columns?)[^.?!]{0,30}(?:needed|required|necessary) to answer|(?:cannot|can(?:no|')t) (?:be )?(?:determine|determined|answer)[^.?!]{0,40}\bfrom (?:this|the) schema)\b""",
            RegexOption.IGNORE_CASE,
        )

        /** Stages that only slice a result; a pipeline made solely of these answers nothing. */
        private val PASSTHROUGH_STAGES = setOf("\$limit", "\$skip", "\$sort", "\$sample")

        /** True when a pipeline selects, groups and computes nothing - it just hands back arbitrary documents. */
        internal fun isNoOpPipeline(pipelineJson: String): Boolean {
            val array = try {
                com.google.gson.JsonParser.parseString(pipelineJson).asJsonArray
            } catch (e: Exception) {
                return false // unparsable is the guard's problem, not this check's
            }
            // `[]` selects nothing; the guard auto-limits it into 1000 arbitrary documents.
            if (array.size() == 0) return true
            return array.all { element ->
                val obj = element as? com.google.gson.JsonObject ?: return@all false
                obj.keySet().isNotEmpty() && obj.keySet().all { it in PASSTHROUGH_STAGES }
            }
        }

        /** A write command offered in an answer: the document counterpart of PROPOSED_WRITE_RE. */
        private val WRITE_COMMAND_RE = Regex(
            "\\bdb\\.\\w+\\.(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|createIndex|dropIndex|drop|renameCollection)\\s*\\(",
            RegexOption.IGNORE_CASE,
        )
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

    /** Same reasoning as [EnginePipeline]'s per-connection overload. */
    fun invalidateCatalogCache(connectionId: String) {
        catalogGeneration.incrementAndGet()
        catalogCache.remove(connectionId)
    }

    /**
     * Drops sampled field values unless the user opted in. Applied at the single exit from
     * [catalog], so a caller cannot leak values by forgetting to ask for the stripped form.
     */
    private fun withoutSampledData(catalog: SchemaCatalog): SchemaCatalog =
        if (allowDataInPrompt) catalog
        else catalog.copy(tables = catalog.tables.map { t -> t.copy(columns = t.columns.map { it.copy(sampledValues = emptyList()) }) })

    private fun requireDatabase(descriptor: ConnectionDescriptor): String =
        descriptor.database?.takeIf { it.isNotBlank() } ?: throw AskSqlException(
            AskSqlErrorCode.CONFIG_ERROR,
            userMessage = "This MongoDB connection has no database name configured.",
        )

    // Catalog (300s TTL, single in-flight fetch per connection): sampling-based, not metadata-based.

    suspend fun catalog(descriptor: ConnectionDescriptor, password: String?, refresh: Boolean = false): SchemaCatalog {
        val cached = catalogCache[descriptor.id]
        if (!refresh && cached != null && System.currentTimeMillis() - cached.fetchedAtMillis < CATALOG_TTL.inWholeMilliseconds) {
            return withoutSampledData(cached.catalog)
        }
        val lock = catalogLocks.getOrPut(descriptor.id) { Mutex() }
        return lock.withLock {
            val recheck = catalogCache[descriptor.id]
            if (!refresh && recheck != null && System.currentTimeMillis() - recheck.fetchedAtMillis < CATALOG_TTL.inWholeMilliseconds) {
                return@withLock withoutSampledData(recheck.catalog)
            }
            val dbName = requireDatabase(descriptor)
            val gen = catalogGeneration.get()
            // Hard Future.get(timeout) bound: a stuck sampling introspection must not hang "Reading schema" forever.
            val fresh = withHardTimeout(60_000) {
                clientRegistry.withClient(descriptor, password) { client ->
                    MongoIntrospector.introspect(client.getDatabase(dbName))
                }
            }
            // An empty catalog WITH warnings is a permission or network failure, not an empty
            // database; caching it presented the database as empty for the next five minutes.
            if (fresh.tables.isEmpty() && fresh.warnings.isNotEmpty()) {
                throw AskSqlException(
                    AskSqlErrorCode.DB_QUERY_ERROR,
                    userMessage = "Could not read this database's collections. Check the connection's permissions, then try again.",
                    detail = "introspection returned no collections with warnings: ${fresh.warnings.joinToString("; ").take(500)}",
                    retryable = true,
                )
            }
            // Skip the write if an edit invalidated mid-fetch, or this stores the old target's schema.
            if (catalogGeneration.get() == gen) catalogCache[descriptor.id] = CachedCatalog(fresh, System.currentTimeMillis())
            withoutSampledData(fresh)
        }
    }

    // ask(): question -> catalog -> prune -> prompt -> LLM -> extract -> guard -> collection floor -> repair loop

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

        // Same routing, and the same order, as the SQL pipeline.
        // Capability questions are answered from the prose path, not by the model.
        if (Scope.isCapabilityQuestion(q)) {
            throw AskSqlException(
                AskSqlErrorCode.LLM_CANNOT_ANSWER,
                userMessage = "That is a question about AskSQL itself rather than the data.",
                detail = "capability question routed to the prose path",
                retryable = false,
            )
        }
        // Declined before any model call.
        if (Scope.isPromptInjection(q)) {
            throw AskSqlException(
                AskSqlErrorCode.LLM_REFUSAL,
                userMessage = "I only answer questions about the data in this database.",
                detail = "prompt-injection attempt declined",
                retryable = false,
            )
        }
        // Asked to be handed a write: refused before a model call and routed to the prose path.
        if (EnginePipeline.isWriteRequest(q)) {
            throw AskSqlException(
                AskSqlErrorCode.LLM_CANNOT_ANSWER,
                userMessage = "That asks for a statement that changes data. AskSQL is read-only, so it is written out for you to run yourself.",
                detail = "write request routed to the proposal path",
                retryable = false,
            )
        }
        // A relationship question asks about the link itself, which the schema already states; a
        // pipeline would return documents instead of describing it. Same routing as the SQL side.
        if (EnginePipeline.isSchemaAdviceQuestion(q) || EnginePipeline.isDatabaseOverviewQuestion(q) ||
            EnginePipeline.isRelationshipQuestion(q)
        ) {
            throw AskSqlException(
                AskSqlErrorCode.LLM_CANNOT_ANSWER,
                userMessage = "That asks about the schema itself rather than the data in it, so there is no query to run.",
                detail = "schema-advice question routed to the prose path",
                retryable = false,
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
        // Tracks a model that says nothing on every attempt, which means unreachable, not bad output.
        var everyReplyEmpty = true
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
                // On context overflow, shrink the schema once and retry without consuming a repair attempt.
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

            if (text.isNotBlank()) everyReplyEmpty = false

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.EXTRACT))
            val extraction = MongoExtract.extractPipeline(text)
            if (extraction == null) {
                val impossibleReason = Extract.extractImpossible(text)
                if (impossibleReason != null) {
                    // A refusal is often a misspelled collection name: one repair attempt, told to disclose it.
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
                    // Nothing at all on every attempt: the model name is wrong or the account cannot reach it.
                    if (everyReplyEmpty) {
                        throw AskSqlException(
                            AskSqlErrorCode.LLM_UNAVAILABLE,
                            userMessage = "The AI model returned an empty response. Check the model name is right and that your account can use it.",
                            detail = "model returned nothing on all ${attempt + 1} attempts",
                        )
                    }
                    val refusal = Extract.looksLikeRefusal(text)
                    throw AskSqlException(
                        if (refusal) AskSqlErrorCode.LLM_REFUSAL else AskSqlErrorCode.LLM_BAD_OUTPUT,
                        // The default message says "SQL", the wrong word on a MongoDB connection.
                        userMessage = "Couldn't produce a valid aggregation pipeline for this question. Try rephrasing it.",
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

            // The document counterpart of the SQL path's literal-answer check.
            if (isNoOpPipeline(extraction.pipelineJson) && CANNOT_ANSWER_RE.containsMatchIn(text)) {
                if (attempt >= MAX_REPAIRS) {
                    throw AskSqlException(
                        AskSqlErrorCode.LLM_BAD_OUTPUT,
                        userMessage = "That question doesn't seem to match any collection in this database.",
                        detail = "pipeline selects nothing (no \$match/\$group/\$project stage)",
                        retryable = false,
                    )
                }
                userPrompt = MongoPrompts.buildRepairUser(
                    question = q, failedPipeline = extraction.pipelineJson, collection = extraction.collection,
                    failure = "That pipeline has no stage that answers the question. Use \$match/\$group/\$project, or reply with IMPOSSIBLE and one sentence saying why.",
                    schemaText = pruned.schemaText,
                )
                attempt++
                continue
            }

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.GUARD))
            // Judged by the guard: a refused rewrite falls back to the model's own pipeline.
            // parsePipeline expects an already-guarded pipeline; this runs before the guard, where
            // shell syntax like new Date(...) throws instead of repairing.
            val rewritten = try {
                MongoNormalise.rewriteDistinctCount(MongoGuard.parsePipeline(extraction.pipelineJson))
            } catch (e: Exception) {
                null
            }
            val rewrittenVerdict = rewritten?.let { stages ->
                MongoGuard.guard(stages.joinToString(",", "[", "]") { it.toJson() }, policy)
            }
            val verdict = if (rewrittenVerdict?.allowed == true) {
                rewrittenVerdict
            } else {
                MongoGuard.guard(extraction.pipelineJson, policy)
            }
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
                    question = q, failedPipeline = extraction.pipelineJson, collection = extraction.collection,
                    failure = "The pipeline validator rejected it: ${verdict.reason ?: verdict.ruleId ?: "not allowed"}. Produce a single read-only pipeline.",
                    schemaText = schemaText,
                )
                attempt++
                continue
            }

            // An unknown collection is a hard block; MongoDB names are case-sensitive, so resolve to the catalog's casing.
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
                    question = q, failedPipeline = verdict.pipelineJson, collection = extraction.collection,
                    failure = "Collection \"${extraction.collection}\" does not exist in the schema. Use only collections from the <schema> block.",
                    schemaText = schemaText,
                )
                attempt++
                continue
            }

            // Quoting floor: a SQL-quoted path names a field MongoDB does not hold, so an aggregate
            // over it returns 0 instead of failing, and nothing downstream can notice.
            // Join-target floor, mirroring packages/core/src/mongo/engine.ts: a $lookup naming a
            // collection that does not exist, or one cased differently, silently joins nothing -
            // the pipeline runs and every joined field comes back empty with no error.
            val unresolvedJoins = verdict.collections.filter { name ->
                fullCatalog.tables.none { it.name.equals(name, ignoreCase = true) }
            }
            if (unresolvedJoins.isNotEmpty()) {
                if (attempt >= MAX_REPAIRS) {
                    throw AskSqlException(
                        AskSqlErrorCode.LLM_CANNOT_ANSWER,
                        userMessage = "I couldn't find a collection called \"${unresolvedJoins.first()}\" referenced by a join. Try rephrasing, or check the schema.",
                        detail = "unknown join collection(s) after repairs: ${unresolvedJoins.joinToString(", ")}",
                        retryable = false,
                    )
                }
                userPrompt = MongoPrompts.buildRepairUser(
                    question = q, failedPipeline = extraction.pipelineJson, collection = extraction.collection,
                    failure = "A join references collection(s) not in the schema: ${unresolvedJoins.joinToString(", ")}. " +
                        "Use only collections from the <schema> block.",
                    schemaText = schemaText,
                )
                attempt++
                continue
            }

            val collectionFields = fullCatalog.tables.firstOrNull { it.name == resolvedCollection }
                ?.columns.orEmpty().map { it.name }.toSet()
            val misquoted = StageFields.firstMisquotedField(MongoGuard.parsePipeline(verdict.pipelineJson), collectionFields)
            if (misquoted != null) {
                if (attempt >= MAX_REPAIRS) {
                    throw AskSqlException(
                        AskSqlErrorCode.LLM_BAD_OUTPUT,
                        userMessage = "The pipeline quotes a field name as `${misquoted.raw}`, which MongoDB reads as a different field.",
                        detail = "misquoted field after repairs: ${misquoted.raw}",
                        retryable = false,
                    )
                }
                userPrompt = MongoPrompts.buildRepairUser(
                    question = q, failedPipeline = extraction.pipelineJson, collection = extraction.collection,
                    failure = "\"\$${misquoted.raw}\" is not a field. MongoDB has no quoting for field paths, so the quote characters " +
                        "become part of the name and the field reads as missing. Write \"\$${misquoted.suggestion}\" instead.",
                    schemaText = schemaText,
                )
                attempt++
                continue
            }

            // Field floor: MongoDB reports these from inside the plan executor, naming the operator
            // rather than the field, so repair it here.
            val stageField = StageFields.firstUnknownStageField(MongoGuard.parsePipeline(verdict.pipelineJson))
            if (stageField != null) {
                if (attempt >= MAX_REPAIRS) {
                    throw AskSqlException(
                        AskSqlErrorCode.LLM_BAD_OUTPUT,
                        userMessage = "The pipeline reads a field called \"${stageField.field}\" that no earlier stage produces.",
                        detail = "unknown field after repairs: ${stageField.field} at stage ${stageField.stage}",
                        retryable = false,
                    )
                }
                userPrompt = MongoPrompts.buildRepairUser(
                    question = q, failedPipeline = extraction.pipelineJson, collection = extraction.collection,
                    failure = "Stage ${stageField.stage + 1} reads \"\$${stageField.field}\", which no earlier stage produces. " +
                        "At that point the document holds only: ${stageField.available.joinToString(", ")}. " +
                        "Remember that \$group replaces the document with its _id and its accumulator outputs.",
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

    // execute(): guards EVERY pipeline, including one the caller already saw guarded once.

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

        // Mongo silently returns zero rows for a nonexistent collection, so the name is re-resolved here.
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
            // Same collection-existence floor and case resolution as ask().
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
        // Guard first: without it, explain() is a free text channel to the model on the host's API key.
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

    /** Prose answer about the database itself, for a question no pipeline can answer. Mirrors [EnginePipeline.explainSchema]. */
    suspend fun explainSchema(
        question: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        llmClient: LlmClient,
        /** Prior turns, so a follow-up like "explain this pipeline" knows which one. */
        context: List<MongoPrompts.ContextTurn> = emptyList(),
    ): Scope.SchemaAnswer {
        val q = question.trim()
        if (q.isEmpty()) throw AskSqlException(AskSqlErrorCode.INVALID_INPUT, userMessage = "Ask a question about the schema.")
        // Length is checked before routing, as in core.
        if (q.length > 10_000) {
            throw AskSqlException(
                AskSqlErrorCode.INVALID_INPUT,
                userMessage = "The question is too long. Keep it under 10,000 characters.",
            )
        }
        // Answered in code rather than by the model.
        if (Scope.isPromptInjection(q)) return Scope.offTopicAnswer("MongoDB")
        if (Scope.isCapabilityQuestion(q)) return Scope.capabilityAnswer("MongoDB")
        val full = catalog(descriptor, password)
        if (full.tables.isEmpty()) {
            return Scope.SchemaAnswer("This connection has no collections the current user can read.", emptyList(), true, emptyList(), false)
        }
        // Advice counts too: names of indexes that do not exist yet are proposals, not hallucinations.
        val isSchemaChange = MONGO_SCHEMA_CHANGE_RE.containsMatchIn(q) || EnginePipeline.isSchemaProposalQuestion(q)
        val pruned = CatalogPruner.pruneCatalog(full, q)
        var answer = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
            llmClient.chat(MongoPrompts.buildSchemaAnswerSystem(isSchemaChange), MongoPrompts.buildSchemaAnswerUser(q, pruned.schemaText, context))
        }.text.trim()
        // Same three signals as the SQL path; the last, prior turns, does not depend on phrasing.
        val questionIsAboutThisDatabase =
            Scope.looksDatabaseRelated(q) || isSchemaChange || Grounding.mentionsCatalogName(q, full) || context.any { it.pipeline.isNotBlank() }
        if (Scope.isOffTopic(answer) || (Scope.isDegenerateAnswer(answer) && !WRITE_COMMAND_RE.containsMatchIn(answer))) {
            // Challenge the refusal once when the question is plainly about data; accept it otherwise.
            if (!questionIsAboutThisDatabase) return Scope.offTopicAnswer("MongoDB")
            answer = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
                llmClient.chat(
                    MongoPrompts.buildSchemaAnswerSystem(isSchemaChange, allowOutOfScope = false),
                    MongoPrompts.buildSchemaAnswerScopeRepairUser(q, pruned.schemaText),
                )
            }.text.trim()
            // Same as the SQL path: after the retry a refusal arrives as prose, not the sentinel.
            if (
                Scope.isOffTopic(answer) ||
                (Scope.isDegenerateAnswer(answer) && !WRITE_COMMAND_RE.containsMatchIn(answer)) ||
                Scope.isProseRefusal(answer, Grounding.mentionsCatalogName(answer, full))
            ) {
                return Scope.offTopicAnswer("MongoDB")
            }
        }
        // Same deterministic backstop as the SQL path, for models too small to follow the rule.
        if (
            !questionIsAboutThisDatabase &&
            !Grounding.mentionsCatalogName(answer, full) &&
            !Scope.looksDatabaseRelated(answer) &&
            !WRITE_COMMAND_RE.containsMatchIn(answer)
        ) {
            return Scope.offTopicAnswer("MongoDB")
        }
        answer = Scope.stripSentinel(answer)
        // The QUESTION counts too: a pasted write command is being discussed.
        if ((WRITE_COMMAND_RE.containsMatchIn(answer) || WRITE_COMMAND_RE.containsMatchIn(q)) && !answer.contains("read-only", ignoreCase = true)) {
            answer += "\n\n*Proposal only - AskSQL is read-only and never executes commands; run it yourself if you want it applied.*"
        }
        // Grounded against the FULL catalog, so a pruned-away collection is not read as an invention.
        // For a change request these are the PROPOSED names, which the UI shows as proposals.
        val unknown = Grounding.unknownReferencesInProse(answer, full, documentStyle = true)
        // The pipeline a prose answer suggested, so a follow-up can refer to it. Read-only only, and
        // only when it names collections and fields that exist.
        val proposed = MongoExtract.extractPipeline(answer)?.pipelineJson?.trim()
        val proposedSql = proposed?.takeIf {
            MongoGuard.guard(it, policy).allowed &&
                Grounding.unknownReferencesInProse(it, full, documentStyle = true).isEmpty()
        }
        return Scope.SchemaAnswer(
            answer, pruned.catalog.tables.map { it.name }, unknown.isEmpty(), unknown, isSchemaChange, proposedSql,
        )
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
